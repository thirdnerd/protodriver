import type { CheckpointId, OperationArgument, OperationRequest, OperationResult } from "@protodriver/contracts";
import { renderAuthoredResult, registerAuthoredFileArgument, collectAuthoredOutput } from "@protodriver/generated-web";
import { authoredStateLabel, stringifyGeneratedPublicJson } from "@protodriver/control-model";
import type { BrowserLoadedDevice } from "./browser-device-admission.ts";
import type { BrowserSessionContext } from "./session-worker-client.ts";
import { BrowserFilePreviewOwner, installBrowserFileResult } from "./file-result.ts";
import { authoredRiskPresentation } from "./authored-risk.ts";
import {
  authoredArgumentControl,
  authoredArgumentField,
  authoredArgumentHint,
  authoredArgumentValue,
  type AuthoredArgumentControl,
  type AuthoredArgumentInput,
} from "./authored-argument.ts";

/** One host-owned continuation, never a general retry loop. A second
 * resume-required terminal result remains visible to the operator. */
export async function runAuthoredOperationWithOneResume(
  client: BrowserSessionContext["client"],
  request: OperationRequest,
  accepted: (operationId: import("@protodriver/contracts").OperationId) => void = () => {},
): Promise<{ readonly outcome: OperationResult; readonly resumeCount: 0 | 1 }> {
  let handle = await client.startOperation(request);
  accepted(handle.operationId);
  let outcome = await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);
  if (outcome.outcome !== "resume-required") return { outcome, resumeCount: 0 };
  if (!outcome.authoredCause) throw new Error("resume-required outcome omitted its authored cause");
  const receipt = outcome.transferReceipt;
  const receiptRecord = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Readonly<Record<string, import("@protodriver/contracts").PublicValue>> : undefined;
  const checkpointId = typeof receiptRecord?.checkpointId === "string" ? receiptRecord.checkpointId as CheckpointId : undefined;
  if (!checkpointId) throw new Error("resume-required outcome omitted its checkpoint identity");
  const inspection = await client.inspectTransferCheckpoint(checkpointId);
  if (inspection.assurance !== "verified") {
    throw new Error("automatic resume requires verified device identity; explicit operator consent is required");
  }
  handle = await client.resumeTransfer({ ...request, checkpointId });
  accepted(handle.operationId);
  outcome = await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);
  return { outcome, resumeCount: 1 };
}

interface ArgumentView {
  readonly control: AuthoredArgumentControl;
  readonly read: () => AuthoredArgumentInput;
  readonly file?: HTMLInputElement;
}

const RESULT_SUMMARY: Readonly<Record<string, string>> = {
  none: "no result",
  value: "returns a value",
  resource: "returns bytes",
  file: "returns a file",
};

function errorRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/** Operation failures render in their own status area, so retain the complete
 * actionable fault rather than reducing an RPC envelope to Error.message. */
export function authoredOperationErrorText(cause: unknown): string {
  const outer = errorRecord(cause);
  const reported = errorRecord(outer?.error) ?? outer;
  if (reported !== undefined && typeof reported.message === "string") {
    const lines = [reported.message];
    if (typeof reported.code === "string") lines.push(`Code: ${reported.code}`);
    if (reported.details !== undefined) lines.push(`Details: ${stringifyGeneratedPublicJson(reported.details)}`);
    return lines.join("\n");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Data-derived controls. The page receives no acquisition callback or Lua VM. */
export function installAuthoredControls(root: HTMLElement, loaded: NonNullable<BrowserLoadedDevice["authored"]>,
  context: BrowserSessionContext, initiallyConnected = false): void {
  const filePreviewOwner = new BrowserFilePreviewOwner();
  root.replaceChildren();

  const header = document.createElement("header");
  header.className = "authored-heading";
  const heading = document.createElement("h1");
  heading.textContent = loaded.model.displayName ?? loaded.model.id;
  header.append(heading);
  if (loaded.model.displayName !== undefined) {
    const identifier = document.createElement("p");
    identifier.className = "mono muted";
    identifier.textContent = loaded.model.id;
    header.append(identifier);
  }
  if (loaded.model.description !== undefined) {
    const description = document.createElement("p");
    description.className = "authored-description";
    description.textContent = loaded.model.description;
    header.append(description);
  }
  const limitation = document.createElement("p");
  limitation.className = "muted";
  limitation.textContent = loaded.hostGrant
    ? `Connected by the host through ${loaded.hostGrant.modeId} / ${loaded.hostGrant.profileId}.`
    : "Connect above before running a task. This package speaks the protocol; the host opens the connection.";
  header.append(limitation);
  root.append(header);

  let connected = initiallyConnected, running = false;
  const active = new Map<string, { readonly progress: HTMLElement; readonly cancel: HTMLButtonElement }>();
  context.client.subscribe(event => {
    if (event.kind === "operation-progress") {
      const view = active.get(event.operationId);
      if (view !== undefined) {
        view.progress.textContent = `Module-reported progress: ${event.phase} · ${event.completed}${event.total === undefined ? "" : ` / ${event.total}`}`;
      }
      return;
    }
    if (event.kind === "transfer-progress") {
      const view = active.get(event.operationId);
      if (view !== undefined) view.progress.textContent = `Host-counted transfer progress: ${event.phase}`;
      return;
    }
    if (event.kind === "operation-end") {
      const view = active.get(event.result.operationId);
      if (view !== undefined) view.cancel.disabled = true;
      return;
    }
    if (event.kind !== "state-cells") return;
    for (const [cell, snapshot] of Object.entries(event.changed)) {
      const view = root.querySelector<HTMLElement>(`[data-authored-state-cell="${CSS.escape(cell)}"]`);
      const control = loaded.model.state[cell]?.valueControl;
      if (view === null || control === undefined) continue;
      view.replaceChildren(stateCellHeading(cell, authoredStateLabel(snapshot)));
      if (snapshot.value !== undefined) {
        const value = document.createElement("p");
        value.className = "state-value";
        value.innerHTML = renderAuthoredResult(control, snapshot.value);
        view.append(value);
      }
    }
  });

  const tasks = document.createElement("section");
  tasks.className = "authored-tasks";
  const tasksHeading = document.createElement("h2");
  tasksHeading.textContent = loaded.model.operations.length === 1 ? "Task" : "Tasks";
  tasks.append(tasksHeading);
  const buttons: HTMLButtonElement[] = [];
  for (const operation of loaded.model.operations) {
    const risk = authoredRiskPresentation(operation);
    const article = document.createElement("article");
    article.className = risk.articleClass;
    article.dataset.authoredOperation = operation.id;

    const operationHeading = document.createElement("div");
    operationHeading.className = "operation-heading";
    const title = document.createElement("h3");
    title.textContent = operation.title;
    operationHeading.append(title);
    if (risk.badge !== null) {
      const badge = document.createElement("span");
      badge.className = "risk-badge";
      badge.textContent = risk.badge;
      operationHeading.append(badge);
    }
    article.append(operationHeading);

    const policy = document.createElement("p");
    policy.className = "operation-policy";
    policy.textContent = [
      risk.repeatability,
      RESULT_SUMMARY[operation.result.kind] ?? operation.result.kind,
    ].join(" · ");
    article.append(policy);

    if (operation.description !== undefined) {
      const description = document.createElement("p");
      description.className = "authored-description";
      description.textContent = operation.description;
      article.append(description);
    }

    const form = document.createElement("form");
    const fields = new Map<string, ArgumentView>();
    const argumentFields = document.createElement("div");
    argumentFields.className = "argument-fields";
    for (const [name, declaration] of Object.entries(operation.arguments)) {
      argumentFields.append(buildArgument(name, authoredArgumentControl(declaration), fields));
    }
    if (fields.size > 0) form.append(argumentFields);

    const run = document.createElement("button"); run.type = "submit"; run.textContent = "Run";
    const permitted = loaded.hostGrant !== null && operation.availability.modes.includes(loaded.hostGrant.modeId)
      && operation.availability.profiles.includes(loaded.hostGrant.profileId);
    run.disabled = !permitted; buttons.push(run);
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary";
    cancel.dataset.cancelOperation = "";
    cancel.textContent = "Cancel"; cancel.disabled = true;
    cancel.addEventListener("click", () => {
      const operationId = [...active.entries()].find(([, view]) => view.cancel === cancel)?.[0];
      if (operationId !== undefined) void context.client.cancelOperation(operationId as import("@protodriver/contracts").OperationId);
    });
    const actions = document.createElement("div"); actions.className = "actions";
    actions.append(run, cancel);
    form.append(actions);

    const progress = document.createElement("p"); progress.dataset.operationProgress = "";
    progress.className = "muted";
    // A task that has not run has no progress to report, and saying so under
    // every idle task is noise rather than information.
    progress.textContent = "No module-reported progress."; progress.hidden = true;
    const output = document.createElement("div"); output.setAttribute("role", "status");
    output.className = "operation-result muted";
    output.textContent = "Not run in this session.";
    const fileResult = document.createElement("div"); fileResult.dataset.fileResult = "";
    form.append(progress, output);
    if (operation.result.kind === "file") form.append(fileResult);
    article.append(form);
    tasks.append(article);

    form.addEventListener("submit", event => {
      event.preventDefault(); if (running || !permitted) return;
      running = true; const disabled = buttons.map(button => button.disabled); buttons.forEach(button => { button.disabled = true; });
      output.classList.remove("task-error", "muted"); output.replaceChildren();
      progress.hidden = false; progress.textContent = "Running.";
      void (async () => {
        const sources: Array<{ close(): Promise<void> }> = [];
        try {
          const args: Record<string, OperationArgument> = {};
          for (const [name, view] of fields) {
            if (view.file !== undefined) {
              const file = view.file.files?.[0]; if (!file) throw new Error("select a file for " + name);
              const source = await registerAuthoredFileArgument(operation, name, file, resource => context.registerResource(resource));
              sources.push(source); args[name] = source.argument;
            } else {
              args[name] = { kind: "value", value: readArgument(name, view) };
            }
          }
          if (!connected) { await context.client.connect({ mode: loaded.hostGrant!.modeId }); connected = true; }
          if (operation.result.kind === "resource" || operation.result.kind === "file") {
            const result = await collectAuthoredOutput(context.client, operation, args, resource => context.registerResource(resource), {
              accepted: operationId => { active.set(operationId, { progress, cancel }); cancel.disabled = false; },
            });
            output.textContent = `${result.blob.size.toLocaleString()} bytes saved`; result.download();
            if (operation.result.kind === "file") {
              const save = document.createElement("button"); save.type = "button"; save.dataset.saveFile = "";
              save.className = "secondary";
              save.textContent = `Save .${operation.result.suggestedExtension ?? "bin"}`;
              const status = document.createElement("p"); status.dataset.filePreviewStatus = ""; status.className = "muted";
              status.textContent = "Preview pending.";
              const image = document.createElement("img"); image.dataset.filePreview = ""; image.alt = `Generated ${operation.title} preview`; image.hidden = true;
              fileResult.replaceChildren(save, status, image);
              installBrowserFileResult(operation.result, result.blob, { save, status, image }, filePreviewOwner);
            }
          } else {
            const { outcome, resumeCount } = await runAuthoredOperationWithOneResume(context.client,
              { operation: operation.id, arguments: args }, operationId => {
                active.set(operationId, { progress, cancel }); cancel.disabled = false;
              });
            if (outcome.outcome !== "completed") throw new Error(stringifyGeneratedPublicJson(outcome));
            output.dataset.hostResumeCount = String(resumeCount);
            output.innerHTML = operation.resultControl === null ? "Completed" : renderAuthoredResult(operation.resultControl, outcome.result);
          }
        } catch (cause) {
          output.classList.add("task-error");
          output.textContent = authoredOperationErrorText(cause);
        }
        finally {
          for (const [operationId, view] of active) if (view.cancel === cancel) active.delete(operationId);
          cancel.disabled = true;
          for (const source of sources) await source.close(); running = false; buttons.forEach((button, i) => { button.disabled = disabled[i]!; });
        }
      })();
    });
  }
  root.append(tasks);

  const cells = Object.keys(loaded.model.state).sort();
  if (cells.length > 0) {
    const state = document.createElement("section");
    state.className = "authored-state";
    const stateHeading = document.createElement("h2");
    stateHeading.textContent = "State";
    state.append(stateHeading);
    const grid = document.createElement("div");
    grid.className = "generated-state";
    for (const cell of cells) {
      const view = document.createElement("div");
      view.className = "state-cell";
      view.dataset.authoredStateCell = cell;
      view.append(stateCellHeading(cell, "Unknown (not observed)"));
      grid.append(view);
    }
    state.append(grid);
    root.append(state);
  }
}

function stateCellHeading(cell: string, quality: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const name = document.createElement("h3");
  name.textContent = cell;
  const label = document.createElement("p");
  label.className = "state-quality muted";
  label.textContent = quality;
  fragment.append(name, label);
  return fragment;
}

/** Reports which argument refused, because the message lands in one shared status line. */
function readArgument(name: string, view: ArgumentView): import("@protodriver/contracts").PublicValue {
  try {
    return authoredArgumentValue(view.control, view.read());
  } catch (cause) {
    throw new Error(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function buildArgument(
  name: string,
  control: AuthoredArgumentControl,
  fields: Map<string, ArgumentView>,
): HTMLElement {
  const field = authoredArgumentField(control);
  const wrapper = document.createElement("div");
  wrapper.className = "argument-field";
  const caption = control.label ?? name;

  if (field.kind === "flags") {
    const group = document.createElement("fieldset");
    group.className = "flag-group";
    const legend = document.createElement("legend");
    legend.textContent = caption;
    group.append(legend);
    const choices = document.createElement("div");
    choices.className = "flag-choices";
    const boxes: HTMLInputElement[] = [];
    for (const member of field.members) {
      const label = document.createElement("label");
      label.className = "boolean-value";
      const box = document.createElement("input");
      box.type = "checkbox"; box.name = name; box.value = member;
      label.append(box, member);
      choices.append(label);
      boxes.push(box);
    }
    group.append(choices);
    wrapper.append(group);
    fields.set(name, { control, read: () => boxes.filter(box => box.checked).map(box => box.value) });
  } else if (field.kind === "checkbox") {
    const label = document.createElement("label");
    label.className = "boolean-value";
    const box = document.createElement("input");
    box.type = "checkbox"; box.name = name;
    label.append(box, caption);
    wrapper.append(label);
    fields.set(name, { control, read: () => box.checked });
  } else {
    const label = document.createElement("label");
    label.textContent = caption;
    if (field.kind === "select") {
      const select = document.createElement("select");
      select.name = name; select.required = true;
      const placeholder = document.createElement("option");
      placeholder.value = ""; placeholder.textContent = "Choose a value";
      select.append(placeholder);
      for (const member of field.members) {
        const option = document.createElement("option");
        option.value = member; option.textContent = member;
        select.append(option);
      }
      label.append(select);
      fields.set(name, { control, read: () => select.value });
    } else {
      const input = document.createElement("input");
      input.name = name; input.required = true;
      if (field.kind === "file") {
        input.type = "file";
        fields.set(name, { control, read: () => "", file: input });
      } else if (field.kind === "number") {
        input.type = "number"; input.step = field.step;
        if (field.minimum !== undefined) input.min = String(field.minimum);
        if (field.maximum !== undefined) input.max = String(field.maximum);
        fields.set(name, { control, read: () => input.value });
      } else {
        input.type = "text";
        if (field.placeholder !== undefined) input.placeholder = field.placeholder;
        if (field.minimumLength !== undefined) input.minLength = field.minimumLength;
        if (field.maximumLength !== undefined) input.maxLength = field.maximumLength;
        fields.set(name, { control, read: () => input.value });
      }
      label.append(input);
    }
    wrapper.append(label);
  }

  const help = control.description ?? authoredArgumentHint(control);
  if (help !== undefined) {
    const note = document.createElement("p");
    note.className = "input-help";
    note.textContent = help;
    wrapper.append(note);
  }
  return wrapper;
}
