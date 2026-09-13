interface BrowserFileModel {
  mediaType: string;
  suggestedExtension?: string;
}

export interface BrowserObjectUrlApi {
  createObjectURL(value: Blob): string;
  revokeObjectURL(url: string): void;
}

interface BrowserDownloadDocument {
  createElement(name: "a"): HTMLAnchorElement;
}

interface BrowserFilePreviewElements {
  readonly image: HTMLImageElement;
  readonly status: HTMLElement;
}

interface BrowserFileResultElements extends BrowserFilePreviewElements {
  readonly save: Pick<HTMLButtonElement, "addEventListener">;
}

export function downloadAuthoredFileResult(
  model: BrowserFileModel,
  value: Blob,
  documentApi: BrowserDownloadDocument = document,
  objectUrls: BrowserObjectUrlApi = URL,
): void {
  const url = objectUrls.createObjectURL(value);
  try {
    const anchor = documentApi.createElement("a");
    anchor.href = url;
    anchor.download = `protodriver-result.${model.suggestedExtension}`;
    anchor.click();
  } finally {
    objectUrls.revokeObjectURL(url);
  }
}

export class BrowserFilePreviewOwner {
  readonly #objectUrls: BrowserObjectUrlApi;
  #ownedUrl: string | undefined;

  constructor(objectUrls: BrowserObjectUrlApi = URL) {
    this.#objectUrls = objectUrls;
  }

  show(value: Blob, elements: BrowserFilePreviewElements): void {
    this.release();
    // The browser has no CSP backstop here. A Blob URL assigned only to an
    // image source is the preview execution boundary: preview bytes never
    // become markup, an object/frame document, or a navigation target. The
    // separate exact-byte path uses only an anchor's download behavior.
    const url = this.#objectUrls.createObjectURL(value);
    this.#ownedUrl = url;
    elements.image.hidden = true;
    elements.status.textContent = "Preview loading.";
    elements.image.onload = () => {
      if (this.#ownedUrl !== url) return;
      elements.image.hidden = false;
      elements.status.textContent = "Preview available.";
    };
    elements.image.onerror = () => {
      if (this.#ownedUrl !== url) return;
      this.release();
      elements.image.hidden = true;
      elements.status.textContent = "Preview unavailable. The original bytes can still be saved.";
    };
    elements.image.src = url;
  }

  release(): void {
    if (this.#ownedUrl === undefined) return;
    this.#objectUrls.revokeObjectURL(this.#ownedUrl);
    this.#ownedUrl = undefined;
  }
}

export function installBrowserFileResult(
  model: BrowserFileModel,
  value: Blob,
  elements: BrowserFileResultElements,
  previewOwner: BrowserFilePreviewOwner,
  documentApi: BrowserDownloadDocument = document,
  objectUrls: BrowserObjectUrlApi = URL,
): void {
  elements.save.addEventListener("click", () => {
    downloadAuthoredFileResult(model, value, documentApi, objectUrls);
  });
  previewOwner.show(value, elements);
}
