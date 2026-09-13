interface CatalogEntry {
  readonly name: string;
  readonly url: URL;
}

interface CatalogView {
  readonly baseURI: string;
  readonly region: HTMLElement;
  readonly select: HTMLSelectElement;
  readonly document: Pick<Document, "createElement">;
  readonly fetcher: (url: string) => Promise<Response>;
  readonly beforeLoad: () => void;
  readonly afterLoad: () => void;
  readonly loadBytes: (bytes: Uint8Array) => Promise<void>;
  readonly onCatalogError: (error: Error) => void;
  readonly onEntryError: (error: unknown) => void;
}

// Discovery makes exactly one same-origin request. A missing or unreachable
// catalog is normal; only a present but malformed document is reported.
export async function installPackageCatalog(view: CatalogView): Promise<void> {
  const requestedUrl = new URL("catalog.json", view.baseURI).href;
  let response: Response;
  try {
    response = await view.fetcher(requestedUrl);
  } catch {
    return;
  }
  if (!response.ok) return;

  const catalogUrl = response.url || requestedUrl;
  let entries: readonly CatalogEntry[];
  try {
    entries = parseCatalog(await response.json(), catalogUrl);
  } catch (cause) {
    view.onCatalogError(new Error(`Package catalog ${catalogUrl} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`));
    return;
  }
  if (entries.length === 0) return;

  view.select.replaceChildren(...entries.map(entry => {
    const option = view.document.createElement("option");
    option.textContent = entry.name;
    return option;
  }));
  view.select.selectedIndex = -1;
  view.select.disabled = false;
  view.region.hidden = false;

  async function loadSelected(): Promise<void> {
    const entry = entries[view.select.selectedIndex];
    if (entry === undefined) return;
    try {
      view.beforeLoad();
    } catch (cause) {
      view.onEntryError(cause);
      return;
    }
    try {
      const host = entry.url.host;
      let packageResponse: Response;
      try {
        packageResponse = await view.fetcher(entry.url.href);
      } catch {
        throw new Error(`Package ${JSON.stringify(entry.name)} from ${host}: browser refused the request or blocked its response`);
      }
      if (!packageResponse.ok) {
        throw new Error(`Package ${JSON.stringify(entry.name)} from ${host}: HTTP ${packageResponse.status}`);
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await packageResponse.arrayBuffer();
      } catch {
        throw new Error(`Package ${JSON.stringify(entry.name)} from ${host}: browser refused to read the response`);
      }
      await view.loadBytes(new Uint8Array(bytes));
    } catch (cause) {
      view.onEntryError(cause);
    } finally {
      view.afterLoad();
    }
  }

  view.select.addEventListener("change", () => { void loadSelected(); });
}

function parseCatalog(value: unknown, catalogUrl: string): readonly CatalogEntry[] {
  if (!record(value) || !Array.isArray(value.packages)) throw new Error("packages must be an array");
  return Object.freeze(value.packages.map((raw: unknown, index: number) => {
    if (!record(raw) || typeof raw.name !== "string" || raw.name.length === 0
        || typeof raw.url !== "string" || raw.url.length === 0) {
      throw new Error(`packages[${index}] requires non-empty name and url strings`);
    }
    return Object.freeze({ name: raw.name, url: new URL(raw.url, catalogUrl) });
  }));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
