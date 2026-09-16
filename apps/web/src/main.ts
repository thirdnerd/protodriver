import type {
  CaptureId,
  CaptureSummary,
  ClientId,
  DiagnosticBatch,
  DiagnosticDropSummary,
  DiagnosticRecord,
  GrantDescriptor,
  RawTerminalId,
  SerializableCandidate,
  SessionSubscription,
} from "@protodriver/contracts";
import { browserExpectedError, browserFailure, browserFailureText } from "./errors.ts";
import { installBrowserReleaseHooks } from "./lifecycle.ts";
import { HexWindow } from "./hex-window.ts";
import { BrowserPackageStore } from "./package-storage.ts";
import {
  BrowserMemoryCaptureDestination,
  DEFAULT_BROWSER_CAPTURE_LIMITS,
  browserCaptureSidecarThresholdBytes,
  openBrowserSessionContext,
  type BrowserCaptureLimits,
  type BrowserSessionContext,
} from "./session-worker-client.ts";
import type {
  BrowserLoadedDevice,
  BrowserWorkerProfile,
} from "./browser-device-admission.ts";
import { usbFilterMatches, type WebUsbFilterDevice } from "./webusb-filter.ts";
import { serialChooserFilters, usbChooserFilters } from "./acquisition-filters.ts";
import { installAuthoredControls } from "./authored-controls.ts";
import { installPackageCatalog } from "./package-catalog.ts";
import { loadAndRememberPackage as loadAndRememberPackageBytes } from "./package-loading.ts";

interface WebSerialApi {
  requestPort(options: {
    readonly filters?: readonly {
      readonly usbVendorId?: number;
      readonly usbProductId?: number;
    }[];
  }): Promise<{ getInfo(): { readonly usbVendorId?: number; readonly usbProductId?: number } }>;
}

interface WebUsbApi {
  requestDevice(options: {
    readonly filters: readonly {
      readonly vendorId?: number;
      readonly productId?: number;
      readonly classCode?: number;
    }[];
  }): Promise<WebUsbFilterDevice>;
}

const connectionState = element("state");
const support = element("support");
const identity = element("identity");
const packageInput = input("package-file");
const catalogRegion = element("catalog-packages");
const catalogSelect = selectElement("catalog-package");
const storedPackageSelect = selectElement("stored-package");
const storedPackageStatus = element("stored-package-status");
const storedPackageLoadButton = button("stored-package-load");
const storedPackageRemoveButton = button("stored-package-remove");
const modeSelect = selectElement("mode");
const profileSelect = selectElement("profile");
const candidatesView = element("candidates");
const connectButton = button("connect");
const disconnectButton = button("disconnect");
const exportButton = button("export");
const captureMemoryInput = input("capture-memory-bytes");
const captureQueueInput = input("capture-queue-bytes");
const pauseButton = button("pause");
const generatedView = element("generated-controls");
const terminalStatus = element("terminal-status");
const terminalContent = element("terminal-content");
const terminalOpenButton = button("terminal-open");
const terminalExitButton = button("terminal-exit");
const terminalWriteForm = element("terminal-write") as HTMLFormElement;
const terminalBytesInput = input("terminal-bytes");
const terminalSendButton = button("terminal-send");
const terminalOutput = element("terminal-output");
const hexView = element("hex");
const dropsView = element("drops");
const protocolStatus = element("protocol-status");
const protocolContent = element("protocol-content");
const errorPanel = element("error-panel");
const errorMessage = element("error-message");
const errorView = element("error");
const workspacePanel = element("workspace");

const serial = (navigator as Navigator & { readonly serial?: WebSerialApi }).serial;
const usb = (navigator as Navigator & { readonly usb?: WebUsbApi }).usb;
const packageStore = new BrowserPackageStore(indexedDB);

let loaded: BrowserLoadedDevice | undefined;
let sessionContext: BrowserSessionContext | undefined;
let sessionEvents: SessionSubscription | undefined;
let diagnosticEvents: { dispose(): void } | undefined;
let connected = false;
let activeModeId: string | undefined;
let activeProfileId: string | undefined;
let activeGrant: GrantDescriptor | undefined;
let rawTerminalActive = false;
let rawTerminalId: RawTerminalId | undefined;
let rawTerminalExitRequirement:
  | { readonly kind: "declared-recovery"; readonly strategy: "reconnect" | "flush-and-sync"; readonly message: string }
  | { readonly kind: "reconnect-required"; readonly message: string }
  | undefined;
let lastCapture: { readonly bytes: Uint8Array; readonly summary: CaptureSummary } | undefined;
let activeCapture: {
  readonly captureId: CaptureId;
  readonly destination: BrowserMemoryCaptureDestination;
  readonly destinationId: import("@protodriver/contracts").CaptureDestinationId;
} | undefined;
let sessionCaptureLimits: BrowserCaptureLimits | undefined;
const renderedHex = new HexWindow();
let paused = false;
let pendingDiagnosticBatch: DiagnosticBatch | undefined;

installBrowserReleaseHooks({
  window,
  release: () => {
    if (!connected) return;
    void requireClient().disconnect("browser lifecycle release").catch(() => {});
  },
});

packageInput.addEventListener("change", () => void loadSelectedPackage());
storedPackageSelect.addEventListener("change", () => updateStoredPackageButtons());
storedPackageLoadButton.addEventListener("click", () => void loadStoredPackage());
storedPackageRemoveButton.addEventListener("click", () => void removeStoredPackage());
modeSelect.addEventListener("change", () => {
  populateProfiles();
  updateConnectButton();
  renderControls();
  renderRawTerminal();
});
profileSelect.addEventListener("change", () => {
  updateConnectButton();
  renderControls();
  renderRawTerminal();
});
connectButton.addEventListener("click", () => void grantAndConnect());
disconnectButton.addEventListener("click", () => void disconnect());
exportButton.addEventListener("click", exportCapture);
pauseButton.addEventListener("click", togglePause);
terminalOpenButton.addEventListener("click", () => void openRawTerminal().catch(showError));
terminalExitButton.addEventListener("click", () => void exitRawTerminal().catch(showError));
terminalWriteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendRawTerminalBytes().catch(showError);
});
captureMemoryInput.addEventListener("change", () => void resetForCaptureSettings());
captureQueueInput.addEventListener("change", () => void resetForCaptureSettings());

function acceptSessionEvent(event: import("@protodriver/contracts").RpcSessionEvent): void {
  if (event.kind === "mode-maintenance") {
    support.textContent = event.status === "released-idle"
      ? `Mode maintenance stopped after declared idle; the next task will re-enter ${event.modeId}.`
      : `Mode ${event.modeId} re-entered; ${event.operation} maintenance is active.`;
    renderControls();
    return;
  }
  if (event.kind === "raw-terminal-bytes") {
    appendTerminalLine(`rx ${event.sequence} @ ${event.tUs} us  ${hexBytes(event.bytes)}`);
    return;
  }
  if (event.kind !== "connection-close") return;
  connected = false;
  rawTerminalActive = false;
  rawTerminalExitRequirement = undefined;
  activeModeId = undefined;
  activeProfileId = undefined;
  setConnected(false);
  support.textContent = `Connection ended: ${event.reason}.`;
  if (event.error !== undefined) showError({ error: event.error });
}

support.textContent = "Load a device package to get its controls.";
captureMemoryInput.value = String(DEFAULT_BROWSER_CAPTURE_LIMITS.maximumCaptureInMemoryBytes);
captureQueueInput.value = String(DEFAULT_BROWSER_CAPTURE_LIMITS.maximumCaptureQueueBytes);
setConnected(false);
void refreshStoredPackages().catch(showError);
void installPackageCatalog({
  baseURI: document.baseURI,
  catalogHref: document.querySelector<HTMLMetaElement>(
    'meta[name="protodriver-package-catalog"]',
  )?.content,
  region: catalogRegion,
  select: catalogSelect,
  document,
  fetcher: url => fetch(url),
  beforeLoad: () => {
    if (connected) throw browserExpectedError(
      "web.package.connected",
      "disconnect before loading another device",
      "invocation",
    );
    clearError();
    setBusy(true, "loading package");
  },
  afterLoad: () => setBusy(false, "disconnected"),
  loadBytes: loadAndRememberPackage,
  onCatalogError: showError,
  onEntryError: cause => {
    if (!connected) clearLoadedDevice();
    showError(cause);
  },
}).catch(showError);

async function loadSelectedPackage(): Promise<void> {
  const file = packageInput.files?.[0];
  if (file === undefined) return;
  if (connected) {
    showError(browserExpectedError("web.package.connected", "disconnect before loading another device", "invocation"));
    return;
  }
  clearError();
  setBusy(true, "loading package");
  try {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch (cause) {
      throw browserExpectedError("web.file.read-failed", `could not read ${file.name}`, "host", cause);
    }
    await loadAndRememberPackage(bytes);
  } catch (cause) {
    clearLoadedDevice();
    showError(cause);
  } finally {
    setBusy(false, "disconnected");
  }
}

async function loadAndRememberPackage(bytes: Uint8Array): Promise<void> {
  await loadAndRememberPackageBytes(bytes, {
    loadDeviceBytes,
    remember: async (value) => {
      try { return await packageStore.add(value); }
      catch (cause) {
        throw browserExpectedError("web.package-store.write-failed", "could not remember the package", "host", cause);
      }
    },
    refreshRemembered: refreshStoredPackages,
    setRememberedStatus: message => { storedPackageStatus.textContent = message; },
    reportRememberError: showError,
  });
}

async function loadStoredPackage(): Promise<void> {
  if (connected) {
    showError(browserExpectedError("web.package.connected", "disconnect before loading another device", "invocation"));
    return;
  }
  const id = selectedStoredPackageId();
  clearError();
  setBusy(true, "loading package");
  storedPackageStatus.textContent = `Loading package ${id}.`;
  try {
    let bytes: Uint8Array | null;
    try { bytes = await packageStore.read(id); }
    catch (cause) {
      throw browserExpectedError("web.package-store.read-failed", `could not read stored package ${id}`, "host", cause);
    }
    if (bytes === null) throw browserExpectedError(
      "web.package-store.missing",
      `stored package ${id} no longer exists`,
      "host",
    );
    const admitted = await loadDeviceBytes(bytes);
    if (admitted.admission.kind !== "pdpkg") {
      throw browserExpectedError(
        "web.package-store.invalid",
        `stored package ${id} did not contain a pdpkg archive`,
        "host",
      );
    }
    storedPackageStatus.textContent = `Package ${id} loaded.`;
  } catch (cause) {
    clearLoadedDevice();
    storedPackageStatus.textContent = `Package ${id} could not be loaded.`;
    showError(cause);
  } finally {
    setBusy(false, "disconnected");
  }
}

async function removeStoredPackage(): Promise<void> {
  const id = selectedStoredPackageId();
  clearError();
  setBusy(true, "forgetting package");
  try {
    try { await packageStore.remove(id); }
    catch (cause) {
      throw browserExpectedError("web.package-store.remove-failed", `could not remove stored package ${id}`, "host", cause);
    }
    await refreshStoredPackages();
    storedPackageStatus.textContent = `Forgot package ${id}.`;
  } catch (cause) {
    showError(cause);
  } finally {
    setBusy(false, "disconnected");
  }
}

async function loadDeviceBytes(bytes: Uint8Array): Promise<BrowserLoadedDevice> {
  sessionEvents?.dispose();
  diagnosticEvents?.dispose();
  await sessionContext?.close();
  const captureLimits = selectedBrowserCaptureLimits();
  const context = await openBrowserSessionContext(bytes, undefined, captureLimits);
  sessionContext = context;
  sessionCaptureLimits = captureLimits;
  await context.client.attach(`browser-main-${crypto.randomUUID()}` as ClientId);
  sessionEvents = context.client.subscribe(acceptSessionEvent);
  diagnosticEvents = context.client.subscribeDiagnostics(acceptDiagnostics);
  const admitted = context.loaded;
  loaded = admitted;
  generatedView.replaceChildren();
  delete generatedView.dataset.authored;
  activeGrant = undefined;
  populateModes();
  renderControls();
  renderRawTerminal();
  support.textContent = `${admitted.authored.model.displayName ?? admitted.authored.model.id} loaded. ${admitted.authored.hostGrant ? "The host supplied its connection." : "Choose a mode and connection profile, then connect."}`;
  return admitted;
}

function clearLoadedDevice(): void {
  loaded = undefined;
  sessionCaptureLimits = undefined;
  generatedView.replaceChildren();
  renderRawTerminal();
}

async function refreshStoredPackages(preferredId?: number): Promise<void> {
  let packages: Awaited<ReturnType<BrowserPackageStore["list"]>>;
  try { packages = await packageStore.list(); }
  catch (cause) {
    throw browserExpectedError("web.package-store.list-failed", "could not list stored packages", "host", cause);
  }
  storedPackageSelect.replaceChildren();
  if (packages.length === 0) {
    appendOption(storedPackageSelect, "", "Nothing remembered yet");
    storedPackageStatus.textContent = "Loading a package from a file also remembers it here.";
  } else {
    for (const stored of packages) {
      appendOption(
        storedPackageSelect,
        String(stored.id),
        `Package ${stored.id} · ${stored.byteLength.toLocaleString()} bytes`,
      );
    }
    const selected = preferredId !== undefined
      && packages.some(({ id }) => id === preferredId)
      ? preferredId
      : packages[0]!.id;
    storedPackageSelect.value = String(selected);
    storedPackageStatus.textContent = `${count(packages.length, "package")} remembered.`;
  }
  updateStoredPackageButtons();
}

function selectedStoredPackageId(): number {
  const id = Number(storedPackageSelect.value);
  if (!Number.isSafeInteger(id) || id < 1) throw browserExpectedError(
    "web.package-store.selection-required",
    "select a stored package first",
    "invocation",
  );
  return id;
}

function updateStoredPackageButtons(busy = false): void {
  const available = storedPackageSelect.value.length > 0;
  storedPackageSelect.disabled = busy || connected || !available;
  storedPackageLoadButton.disabled = busy || connected || !available;
  storedPackageRemoveButton.disabled = busy || connected || !available;
}

function populateModes(): void {
  const current = requireLoaded();
  modeSelect.replaceChildren();
  if (current.authored.model.modes.length > 1) appendOption(modeSelect, "", "Choose a mode");
  for (const modeId of current.authored.model.modes) {
    appendOption(modeSelect, modeId,
      current.authored.model.modePresentation?.[modeId]?.label ?? displayLabel(modeId));
  }
  populateProfiles();
}

function populateProfiles(): void {
  const current = requireLoaded();
  profileSelect.replaceChildren();
  if (modeSelect.value.length === 0) return;
  for (const profile of current.profiles.filter(({ modeId }) => modeId === modeSelect.value)) {
    appendOption(
      profileSelect,
      profile.profileId,
      `${displayLabel(profile.profileId)} · ${profile.transport}${profile.supported ? "" : " · unsupported"}`,
    );
  }
}

async function grantAndConnect(): Promise<void> {
  if (connected) return;
  const profile = selectedProfile();
  clearError();
  if (!profile.supported) {
    support.textContent = `${profile.transport} is unsupported by this host.`;
    renderControls();
    return;
  }
  try {
    // Choosers stay on the main thread and inside this user-gesture turn. The
    // worker can only enumerate grants already made here.
    if (profile.transport === "serial") {
      if (serial === undefined) throw browserExpectedError(
        "web.serial.unavailable",
        "Web Serial is unavailable",
        "host",
      );
      const port = await serial.requestPort(serialChooserFilters(profile.acquisitionFilters));
      const info = port.getInfo();
      activeGrant = browserGrant(profile.acquisitionFilters.map((filter) =>
        (filter.vendorId === undefined || filter.vendorId === info.usbVendorId)
        && (filter.productId === undefined || filter.productId === info.usbProductId)));
    } else {
      if (usb === undefined) throw browserExpectedError("web.usb.unavailable", "WebUSB is unavailable", "host");
      const device = await usb.requestDevice(usbChooserFilters(profile.acquisitionFilters));
      activeGrant = browserGrant(profile.acquisitionFilters.map((filter) =>
        usbFilterMatches(filter, device)));
    }
    const candidates = (await requireClient().resolveCandidates({
      mode: profile.modeId,
      profile: profile.profileId,
      grant: activeGrant,
    }))
      .filter(({ matchedProfileId }) => matchedProfileId === profile.profileId);
    if (candidates.length === 1) await connectCandidate(candidates[0]!.candidateId, profile);
    else renderCandidates(candidates, profile);
  } catch (cause) {
    showError(cause);
  }
}

async function connectCandidate(candidateId: string, profile: BrowserWorkerProfile): Promise<void> {
  setBusy(true, "connecting");
  clearError();
  clearCandidates();
  let opened = false;
  try {
    const candidate = (await requireClient().resolveCandidates({
      mode: profile.modeId,
      profile: profile.profileId,
      ...(activeGrant === undefined ? {} : { grant: activeGrant }),
    }))
      .find((value) => value.candidateId === candidateId && value.matchedProfileId === profile.profileId);
    if (candidate === undefined) throw browserExpectedError(
      "web.acquisition.candidate-expired",
      `candidate ${candidateId} is no longer authorized`,
      "operation",
    );
    // Unique regression: authored entry liveness can precede capture when the
    // browser waits to arm recording until after connect has completed.
    let resolveCaptureIssued!:()=>void;
    const captureIssued=new Promise<void>(resolve=>{resolveCaptureIssued=resolve;});
    const capturePromise=beginMemoryCapture(resolveCaptureIssued);
    // The deferred authored worker cannot exist until the chooser-selected
    // candidate reaches connect. Issue capture first, then let connect create
    // the server that accepts that already-ordered request.
    await Promise.race([captureIssued,capturePromise]);
    const connectPromise = requireClient().connect({
      mode: profile.modeId,
      profile: profile.profileId,
      candidateId: candidate.candidateId,
      ...(activeGrant === undefined ? {} : { grant: activeGrant }),
    });
    const [,result]=await Promise.all([capturePromise,connectPromise]);
    if (result.kind === "selection-required") {
      await retainActiveCapture();
      renderCandidates(result.candidates, profile);
      setConnected(false);
      return;
    }
    opened = true;
    connected = true;
    activeModeId = result.modeId;
    activeProfileId = result.profileId;
    if (loaded !== undefined) {
      loaded = { ...loaded, authored: { ...loaded.authored,
        hostGrant: { modeId: result.modeId, profileId: result.profileId } } };
      delete generatedView.dataset.authored;
    }
    identity.textContent = identityText(candidate.identity);
    setConnected(true);
    renderRawTerminal();
    support.textContent = `Connected through ${displayLabel(result.modeId)} / ${displayLabel(result.profileId)}.`;
  } catch (cause) {
    await retainActiveCapture().catch(() => undefined);
    if (opened) await requireClient().disconnect("post-connect browser setup failed").catch(() => undefined);
    connected = false;
    rawTerminalActive = false;
    rawTerminalExitRequirement = undefined;
    setConnected(false);
    showError(cause);
  }
}

async function beginMemoryCapture(requestIssued:()=>void=()=>{}): Promise<void> {
  const context = requireSessionContext();
  const limits = requireSessionCaptureLimits();
  const destination = new BrowserMemoryCaptureDestination(
    context.resources,
    context.sessionId,
    limits,
  );
  const destinationId = await context.registerCaptureDestination(destination);
  try {
    const pending=context.client.startCapture(destinationId, {
      sidecarThresholdBytes: browserCaptureSidecarThresholdBytes(limits),
    });
    requestIssued();
    const captureId = await pending;
    activeCapture = { captureId, destination, destinationId };
  } catch (cause) {
    await context.captureDestinations.release(destinationId);
    throw cause;
  }
}

async function disconnect(): Promise<void> {
  if (!connected) return;
  setBusy(true, "disconnecting");
  try {
    await retainActiveCapture();
    await requireClient().disconnect("operator disconnect");
    connected = false;
    activeModeId = undefined;
    activeProfileId = undefined;
    activeGrant = undefined;
    setConnected(false);
    support.textContent = "Disconnected. The browser still remembers permission for this device.";
  } catch (cause) {
    showError(cause);
  }
}

async function retainActiveCapture(): Promise<void> {
  const capture = activeCapture;
  if (capture === undefined) return;
  const summary = await requireClient().stopCapture(capture.captureId);
  lastCapture = { bytes: capture.destination.bytes(), summary };
  await requireSessionContext().captureDestinations.release(capture.destinationId);
  activeCapture = undefined;
  exportButton.disabled = false;
}

function renderControls(): void {
  workspacePanel.hidden = loaded === undefined;
  if (loaded === undefined) {
    generatedView.replaceChildren();
    return;
  }
  if (!generatedView.dataset.authored) {
    installAuthoredControls(generatedView, loaded.authored, sessionContext!, connected);
    generatedView.dataset.authored = "true";
  }
}

function renderCandidates(candidates: readonly SerializableCandidate[], profile: BrowserWorkerProfile): void {
  clearCandidates();
  for (const candidate of candidates) {
    const candidateButton = document.createElement("button");
    candidateButton.type = "button";
    candidateButton.className = "secondary";
    candidateButton.textContent = (candidate.ambiguousWith?.length ?? 0) === 0
      ? candidate.displayName
      : `${candidate.displayName} · ambiguous with ${candidate.ambiguousWith!.join(", ")}`;
    candidateButton.addEventListener("click", () => void connectCandidate(candidate.candidateId, profile));
    candidatesView.append(candidateButton);
  }
  support.textContent = candidates.length === 0
    ? "The device you picked does not match this connection profile."
    : `${count(candidates.length, "device")} matched. Choose which one to connect.`;
}

function acceptDiagnostics(batch: DiagnosticBatch): void {
  if (paused) {
    pendingDiagnosticBatch = batch;
    return;
  }
  renderDiagnosticRecords(batch.records, batch.dropped);
}

function renderDiagnosticRecords(records: readonly DiagnosticRecord[], dropped: DiagnosticDropSummary): void {
  renderProtocolTools();
  let text = "";
  for (const record of records) text = renderedHex.append(record);
  if (text.length > 0) {
    hexView.textContent = text;
    hexView.scrollTop = hexView.scrollHeight;
  }
  dropsView.textContent = dropped.records === 0
    ? "No diagnostic loss."
    : `${dropped.records} records / ${dropped.bytes} bytes dropped, ${dropped.firstUs}..${dropped.lastUs} µs.`;
}

function togglePause(): void {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume" : "Pause";
  if (paused) return;
  const pending = pendingDiagnosticBatch;
  pendingDiagnosticBatch = undefined;
  if (pending !== undefined) {
    renderDiagnosticRecords(pending.records, pending.dropped);
  }
}

function exportCapture(): void {
  const capture = lastCapture;
  if (capture === undefined) return;
  const url = URL.createObjectURL(new Blob([capture.bytes], { type: "application/x-ndjson" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${capture.summary.captureId}.pdcap`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function selectedProfile(): BrowserWorkerProfile {
  const profile = requireLoaded().profiles.find(({ modeId, profileId }) => modeId === modeSelect.value && profileId === profileSelect.value);
  if (profile === undefined) throw browserExpectedError(
    "web.acquisition.profile-required",
    "select a declared connection profile",
    "invocation",
  );
  return profile;
}

function renderRawTerminal(): void {
  if (loaded === undefined) {
    terminalContent.hidden = true;
    terminalStatus.textContent = "Load a device package to determine terminal availability.";
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
    return;
  }
  const profile = loaded.profiles.find(({ modeId, profileId }) => (
    modeId === (activeModeId ?? modeSelect.value)
      && profileId === (activeProfileId ?? profileSelect.value)
  ));
  if (profile === undefined) {
    terminalContent.hidden = true;
    terminalStatus.textContent = "Select a connection profile.";
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
    return;
  }
  if (profile.rawTerminal.kind === "unavailable") {
    terminalContent.hidden = true;
    terminalStatus.textContent = `Unavailable: ${profile.rawTerminal.reason}`;
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
    return;
  }
  terminalContent.hidden = false;
  if (rawTerminalActive) {
    terminalStatus.textContent = rawTerminalExitRequirement?.message
      ?? "Raw terminal owns the declared byte-stream channel.";
  } else {
    terminalStatus.textContent = connected
      ? `Available on declared byte-stream channel ${profile.rawTerminal.channelId}.`
      : `Raw terminal will use declared byte-stream channel ${profile.rawTerminal.channelId} after connection.`;
  }
  terminalOpenButton.disabled = !connected || rawTerminalActive;
  terminalExitButton.disabled = !rawTerminalActive;
  terminalBytesInput.disabled = !rawTerminalActive;
  terminalSendButton.disabled = !rawTerminalActive;
}

async function openRawTerminal(): Promise<{ readonly exitRequirement: NonNullable<typeof rawTerminalExitRequirement> }> {
  if (!connected || rawTerminalActive) throw browserExpectedError(
    "web.terminal.state",
    "raw terminal cannot open in the current session state",
    "invocation",
  );
  clearError();
  const subscriptionId = sessionEvents?.subscriptionId;
  if (subscriptionId === undefined) throw new Error("session event subscription is unavailable");
  const opened = await requireClient().openRawTerminal(subscriptionId);
  rawTerminalActive = true;
  rawTerminalId = opened.terminalId;
  rawTerminalExitRequirement = opened.exitRequirement;
  terminalOutput.textContent = "";
  renderControls();
  renderRawTerminal();
  return opened;
}

async function exitRawTerminal(): Promise<void> {
  if (!rawTerminalActive || rawTerminalExitRequirement === undefined) return;
  if (rawTerminalExitRequirement.kind === "reconnect-required"
      && !window.confirm(`${rawTerminalExitRequirement.message} Continue?`)) return;
  if (rawTerminalId === undefined) throw new Error("raw terminal id is unavailable");
  const result = await requireClient().exitRawTerminal(rawTerminalId);
  rawTerminalActive = false;
  rawTerminalId = undefined;
  rawTerminalExitRequirement = undefined;
  appendTerminalLine(result.kind === "recovered"
    ? `${result.recovery.strategy} recovery re-established the mode`
    : "reconnect re-established the mode");
  renderControls();
  renderRawTerminal();
}

async function sendRawTerminalBytes(): Promise<void> {
  if (!rawTerminalActive) throw browserExpectedError(
    "web.terminal.not-open",
    "raw terminal is not open",
    "invocation",
  );
  const bytes = parseHexBytes(terminalBytesInput.value);
  if (rawTerminalId === undefined) throw new Error("raw terminal id is unavailable");
  const receipt = await requireClient().writeRawTerminal(rawTerminalId, bytes);
  appendTerminalLine(`tx ${receipt.atSequence}  ${hexBytes(bytes)}  [${receipt.outcome.kind}]`);
  terminalBytesInput.value = "";
  if (receipt.outcome.kind !== "accepted-by-platform") {
    throw browserExpectedError(
      "web.terminal.write-incomplete",
      `raw terminal write was ${receipt.outcome.kind}`,
      "operation",
    );
  }
}

function parseHexBytes(value: string): Uint8Array {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(compact)) {
    throw browserExpectedError(
      "web.terminal.bytes-invalid",
      "raw terminal bytes must be one or more complete hexadecimal octets",
      "invocation",
    );
  }
  return Uint8Array.from(compact.match(/../gu)!.map((octet) => Number.parseInt(octet, 16)));
}

function hexBytes(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function appendTerminalLine(line: string): void {
  const maximumCharacters = 64 * 1024;
  const next = `${terminalOutput.textContent ?? ""}${line}\n`;
  terminalOutput.textContent = next.length <= maximumCharacters
    ? next
    : next.slice(next.length - maximumCharacters);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function setConnected(value: boolean): void {
  connectionState.textContent = value ? "connected" : "disconnected";
  connectionState.classList.toggle("connected", value);
  packageInput.disabled = value;
  catalogSelect.disabled = value || catalogSelect.options.length === 0;
  modeSelect.disabled = value;
  profileSelect.disabled = value;
  captureMemoryInput.disabled = value;
  captureQueueInput.disabled = value;
  connectButton.disabled = value || loaded === undefined || profileSelect.value.length === 0;
  disconnectButton.disabled = !value;
  pauseButton.disabled = !value;
  identity.hidden = !value;
  updateStoredPackageButtons();
  renderControls();
  renderRawTerminal();
  renderProtocolTools();
}

function renderProtocolTools(): void {
  const available = connected || lastCapture !== undefined;
  protocolContent.hidden = !available;
  pauseButton.hidden = !available;
  protocolStatus.textContent = available
    ? connected
      ? "Live protocol bytes from the active session."
      : "Protocol bytes remain available from the retained session capture."
    : "Unavailable until a session is active or a retained capture exists.";
}

function setBusy(busy: boolean, label: string): void {
  connectionState.textContent = label;
  packageInput.disabled = busy || connected;
  catalogSelect.disabled = busy || connected || catalogSelect.options.length === 0;
  modeSelect.disabled = busy || connected || loaded === undefined;
  profileSelect.disabled = busy || connected || loaded === undefined;
  captureMemoryInput.disabled = busy || connected;
  captureQueueInput.disabled = busy || connected;
  connectButton.disabled = busy || connected || loaded === undefined || profileSelect.value.length === 0;
  disconnectButton.disabled = busy || !connected;
  updateStoredPackageButtons(busy);
  if (busy) {
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
  } else {
    renderRawTerminal();
  }
}

function updateConnectButton(): void {
  connectButton.disabled = connected || loaded === undefined || profileSelect.value.length === 0;
}

function showError(cause: unknown): void {
  const error = browserFailure(cause);
  errorPanel.hidden = false;
  errorMessage.textContent = browserFailureText(error);
  errorView.textContent = JSON.stringify(error, null, 2);
}

function clearError(): void {
  errorPanel.hidden = true;
  errorMessage.textContent = "";
  errorView.textContent = "";
}

function requireSessionContext(): BrowserSessionContext {
  if (sessionContext === undefined) throw browserExpectedError(
    "web.session.required",
    "load a device before using the session",
    "invocation",
  );
  return sessionContext;
}

function requireClient(): import("@protodriver/contracts").DeviceSessionClient {
  return requireSessionContext().client;
}

function selectedBrowserCaptureLimits(): BrowserCaptureLimits {
  const maximumCaptureInMemoryBytes = Number(captureMemoryInput.value);
  const maximumCaptureQueueBytes = Number(captureQueueInput.value);
  if (!Number.isSafeInteger(maximumCaptureQueueBytes) || maximumCaptureQueueBytes <= 0) {
    throw browserExpectedError(
      "web.capture.queue-limit-invalid",
      "maximum capture queue bytes must be a positive integer",
      "invocation",
    );
  }
  if (!Number.isSafeInteger(maximumCaptureInMemoryBytes)
      || maximumCaptureInMemoryBytes <= maximumCaptureQueueBytes) {
    throw browserExpectedError(
      "web.capture.memory-limit-invalid",
      "capture memory bytes must be an integer greater than maximum capture queue bytes",
      "invocation",
    );
  }
  return Object.freeze({ maximumCaptureQueueBytes, maximumCaptureInMemoryBytes });
}

function requireSessionCaptureLimits(): BrowserCaptureLimits {
  if (sessionCaptureLimits === undefined) throw browserExpectedError(
    "web.capture.session-required",
    "capture limits are unavailable until a device is loaded",
    "invocation",
  );
  return sessionCaptureLimits;
}

async function resetForCaptureSettings(): Promise<void> {
  if (connected) return;
  try {
    selectedBrowserCaptureLimits();
    sessionEvents?.dispose();
    diagnosticEvents?.dispose();
    await sessionContext?.close();
    sessionContext = undefined;
    clearLoadedDevice();
    packageInput.value = "";
    support.textContent = "Capture limits changed. Load the package again to apply them.";
  } catch (cause) {
    showError(cause);
  }
}

function browserGrant(matches: readonly boolean[]): GrantDescriptor {
  const matchedFilters = matches.flatMap((matched, index) => matched ? [index] : []);
  if (matchedFilters.length === 0) {
    throw browserExpectedError(
      "web.acquisition.grant-mismatch",
      "the granted device does not match any requested profile filter",
      "invocation",
    );
  }
  return {
    grantId: crypto.randomUUID() as import("@protodriver/contracts").GrantId,
    matchedFilters: Object.freeze(matchedFilters),
  };
}

function requireLoaded(): BrowserLoadedDevice {
  if (loaded === undefined) throw browserExpectedError(
    "web.package.required",
    "load a device package first",
    "invocation",
  );
  return loaded;
}

function identityText(value: import("@protodriver/contracts").PhysicalDeviceIdentity): string {
  const ids = value.vendorId === undefined || value.productId === undefined
    ? value.transport
    : `${value.vendorId.toString(16).padStart(4, "0")}:${value.productId.toString(16).padStart(4, "0")}`;
  return [value.productName, ids, value.serialNumber].filter((member) => member !== undefined).join(" · ");
}

function appendOption(target: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  target.append(option);
}

function displayLabel(value: string): string { return value.replace(/[_-]+/gu, " "); }
function count(total: number, noun: string): string { return `${total} ${noun}${total === 1 ? "" : "s"}`; }
function clearCandidates(): void { candidatesView.replaceChildren(); }
function element(id: string): HTMLElement { return required(document.getElementById(id), `#${id}`); }
function button(id: string): HTMLButtonElement { return required(document.querySelector<HTMLButtonElement>(`#${id}`), `#${id}`); }
function input(id: string): HTMLInputElement { return required(document.querySelector<HTMLInputElement>(`#${id}`), `#${id}`); }
function selectElement(id: string): HTMLSelectElement { return required(document.querySelector<HTMLSelectElement>(`#${id}`), `#${id}`); }
function required<T>(value: T | null | undefined, name: string): T { if (value === null || value === undefined) throw new Error(`${name} is missing`); return value; }
