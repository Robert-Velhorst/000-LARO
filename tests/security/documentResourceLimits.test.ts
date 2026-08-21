import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const pdf = vi.hoisted(() => ({
  getDocument: vi.fn(),
  loadingDestroy: vi.fn(),
  getInfo: vi.fn(),
  getText: vi.fn(),
  getScreenshot: vi.fn(),
  destroy: vi.fn(),
}));

const ocrWorker = vi.hoisted(() => ({
  startSession: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    doc: unknown;
    getInfo = pdf.getInfo;
    getText = pdf.getText;
    getScreenshot = pdf.getScreenshot;
    destroy = pdf.destroy;
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdf.getDocument,
}));

vi.mock("../../server/ocrWorker", () => ({
  startOcrWorkerSession: ocrWorker.startSession,
}));

import { extractDocumentText } from "../../server/documentIntelligence";
import { extractImageBatchText, extractImageText } from "../../server/ocr";

function pngHeader(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function bmpInfoHeader(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(54);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  return bytes;
}

function bmpCoreHeader(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(26);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(12, 14);
  bytes.writeUInt16LE(width, 18);
  bytes.writeUInt16LE(height, 20);
  return bytes;
}

function gifHeader(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpegHeader(width = 1, height = 1): Buffer {
  const bytes = Buffer.from("ffd8ffc00008080001000103011100", "hex");
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function webpHeader(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function pbmHeader(width = 1, height = 1): Buffer {
  return Buffer.from(`P1\n${width} ${height}\n0\n`, "ascii");
}

async function docxWithText(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
  zip.folder("_rels")?.file(".rels", "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>");
  zip.folder("word")?.file("document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

describe("document analysis resource limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pdf.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
      destroy: pdf.loadingDestroy,
    });
    pdf.loadingDestroy.mockResolvedValue(undefined);
    pdf.getInfo.mockResolvedValue({
      total: 1,
      pages: [{ pageNumber: 1, width: 595, height: 842 }],
    });
    pdf.getText.mockResolvedValue({
      text: "A sufficiently readable legal document page.",
      pages: [{ text: "A sufficiently readable legal document page." }],
    });
    pdf.getScreenshot.mockResolvedValue({ pages: [], total: 1 });
    pdf.destroy.mockResolvedValue(undefined);
    ocrWorker.recognize.mockResolvedValue({ data: { text: "text", confidence: 95 } });
    ocrWorker.terminate.mockResolvedValue(undefined);
    ocrWorker.startSession.mockReturnValue({
      ready: Promise.resolve(),
      recognize: ocrWorker.recognize,
      terminate: ocrWorker.terminate,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects PDFs over the page limit before extracting page content", async () => {
    pdf.getInfo.mockResolvedValue({ total: 201, pages: [] });

    await expect(extractDocumentText(Buffer.from("pdf"), "application/pdf"))
      .rejects.toThrow("PDF exceeds the 200 page analysis limit");
    expect(pdf.getText).not.toHaveBeenCalled();
    expect(pdf.getScreenshot).not.toHaveBeenCalled();
  });

  it("bounds concurrent document extraction and its waiting queue", async () => {
    let releaseInfo!: (value: { total: number; pages: Array<{ pageNumber: number; width: number; height: number }> }) => void;
    const blockedInfo = new Promise<{ total: number; pages: Array<{ pageNumber: number; width: number; height: number }> }>((resolve) => {
      releaseInfo = resolve;
    });
    pdf.getInfo.mockReturnValue(blockedInfo);

    const accepted = Array.from({ length: 10 }, () =>
      extractDocumentText(Buffer.from("pdf"), "application/pdf")
    );
    await vi.waitFor(() => expect(pdf.getInfo.mock.calls.length).toBeGreaterThanOrEqual(2));
    const overflow = extractDocumentText(Buffer.from("pdf"), "application/pdf");
    releaseInfo({ total: 1, pages: [{ pageNumber: 1, width: 595, height: 842 }] });

    await expect(overflow).rejects.toThrow("Document analysis queue is full");
    await expect(Promise.all(accepted)).resolves.toHaveLength(10);
    expect(pdf.getInfo).toHaveBeenCalledTimes(10);
  });

  it("extracts PDF text incrementally instead of retaining every parsed page at once", async () => {
    pdf.getInfo.mockResolvedValue({
      total: 2,
      pages: [
        { pageNumber: 1, width: 595, height: 842 },
        { pageNumber: 2, width: 595, height: 842 },
      ],
    });
    pdf.getText.mockImplementation(async ({ partial }: { partial: number[] }) => ({
      text: `Readable legal content from page ${partial[0]}.`,
      pages: [{ text: `Readable legal content from page ${partial[0]}.` }],
    }));

    const result = await extractDocumentText(Buffer.from("pdf"), "application/pdf");

    expect(result.method).toBe("pdf_text");
    expect(pdf.getText.mock.calls.map(([options]) => options)).toEqual([
      { partial: [1] },
      { partial: [2] },
    ]);
  });

  it("rejects decompressed PDF text beyond the analysis budget", async () => {
    const expandedText = "A".repeat(8 * 1024 * 1024 + 1);
    pdf.getText.mockResolvedValue({ text: expandedText, pages: [{ text: expandedText }] });

    await expect(extractDocumentText(Buffer.from("pdf"), "application/pdf"))
      .rejects.toThrow("PDF text exceeds the 8 MB analysis limit");
    expect(pdf.getScreenshot).not.toHaveBeenCalled();
  });

  it("rejects text-only PDFs when page separators push final text over budget", async () => {
    const pageText = "A".repeat(4 * 1024 * 1024);
    pdf.getInfo.mockResolvedValue({
      total: 2,
      pages: [
        { pageNumber: 1, width: 595, height: 842 },
        { pageNumber: 2, width: 595, height: 842 },
      ],
    });
    pdf.getText.mockResolvedValue({ text: pageText, pages: [{ text: pageText }] });

    await expect(extractDocumentText(Buffer.from("pdf"), "application/pdf"))
      .rejects.toThrow("PDF text exceeds the 8 MB analysis limit");
  });

  it("cancels and awaits PDF initialization when the document deadline expires", async () => {
    vi.useFakeTimers();
    let finishDestroy!: () => void;
    const destroyed = new Promise<void>((resolve) => { finishDestroy = resolve; });
    pdf.getDocument.mockReturnValue({
      promise: new Promise<never>(() => { /* Intentionally pending until the deadline cancels loading. */ }),
      destroy: vi.fn(() => destroyed),
    });

    const extraction = extractDocumentText(Buffer.from("pdf"), "application/pdf");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    let settled = false;
    void extraction.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    finishDestroy();
    await expect(extraction).rejects.toThrow("Document extraction exceeded the 5 minute processing limit");
    vi.useRealTimers();
  });

  it("surfaces a PDF renderer cleanup failure instead of releasing silently", async () => {
    vi.useFakeTimers();
    pdf.getDocument.mockReturnValue({
      promise: new Promise<never>(() => { /* Intentionally pending until cancellation. */ }),
      destroy: vi.fn().mockRejectedValue(new Error("renderer remained active")),
    });

    const extraction = extractDocumentText(Buffer.from("pdf"), "application/pdf");
    const assertion = expect(extraction).rejects.toThrow(
      "PDF initialization failed and its renderer could not be stopped safely",
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await assertion;
  });

  it("rejects a compressed DOCX that expands beyond the extraction budget", async () => {
    const bytes = await docxWithText("A".repeat(8 * 1024 * 1024 + 1));
    expect(bytes.length).toBeLessThan(100_000);

    await expect(extractDocumentText(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .rejects.toThrow("DOCX expanded content exceeds the 8 MB per-entry analysis limit");
  });

  it("preserves ordinary DOCX extraction", async () => {
    const bytes = await docxWithText("This is a normal legal document with readable text.");

    await expect(extractDocumentText(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .resolves.toMatchObject({ method: "docx_text", text: "This is a normal legal document with readable text." });
  });

  it("rejects pathological PDF page dimensions before canvas rendering", async () => {
    pdf.getInfo.mockResolvedValue({
      total: 1,
      pages: [{ pageNumber: 1, width: 1, height: 100_000 }],
    });
    pdf.getText.mockResolvedValue({ text: "", pages: [{ text: "" }] });

    await expect(extractDocumentText(Buffer.from("pdf"), "application/pdf"))
      .rejects.toThrow("PDF page 1 exceeds the raster pixel limit");
    expect(pdf.getScreenshot).not.toHaveBeenCalled();
  });

  it("rejects PDFs that would require OCR beyond the page budget", async () => {
    pdf.getInfo.mockResolvedValue({
      total: 26,
      pages: Array.from({ length: 26 }, (_, index) => ({
        pageNumber: index + 1,
        width: 595,
        height: 842,
      })),
    });
    pdf.getText.mockResolvedValue({ text: "", pages: [{ text: "" }] });

    await expect(extractDocumentText(Buffer.from("pdf"), "application/pdf"))
      .rejects.toThrow("PDF requires OCR for more than 25 pages");
    expect(pdf.getScreenshot).not.toHaveBeenCalled();
  });

  it("renders and OCRs accepted PDF pages in bounded chunks", async () => {
    pdf.getInfo.mockResolvedValue({
      total: 6,
      pages: Array.from({ length: 6 }, (_, index) => ({
        pageNumber: index + 1,
        width: 595,
        height: 842,
      })),
    });
    pdf.getText.mockResolvedValue({ text: "", pages: [{ text: "" }] });
    pdf.getScreenshot.mockImplementation(async ({ partial }: { partial: number[] }) => ({
      total: 6,
      pages: partial.map((pageNumber) => ({
        pageNumber,
        width: 1_800,
        height: 2_548,
        data: new Uint8Array(pngHeader(1_800, 2_548)),
      })),
    }));

    const result = await extractDocumentText(Buffer.from("pdf"), "application/pdf");

    expect(result.method).toBe("pdf_ocr");
    expect(pdf.getScreenshot.mock.calls.map(([options]) => options.partial)).toEqual([
      [1, 2, 3, 4, 5],
      [6],
    ]);
  });

  it("rejects OCR-expanded PDF text beyond the analysis budget", async () => {
    pdf.getText.mockResolvedValue({ text: "", pages: [{ text: "" }] });
    pdf.getScreenshot.mockResolvedValue({
      total: 1,
      pages: [{
        pageNumber: 1,
        width: 1_800,
        height: 2_548,
        data: new Uint8Array(pngHeader(1_800, 2_548)),
      }],
    });
    ocrWorker.recognize.mockResolvedValue({
      data: { text: "A".repeat(8 * 1024 * 1024 + 1), confidence: 95 },
    });

    let error: unknown;
    try {
      await extractDocumentText(Buffer.from("pdf"), "application/pdf");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("PDF extracted text exceeds the 8 MB analysis limit");
  });

  it("rejects oversized OCR batches before starting a worker", async () => {
    const pages = Array.from({ length: 26 }, () => pngHeader());

    await expect(extractImageBatchText(pages))
      .rejects.toThrow("OCR batches are limited to 25 images");
    expect(ocrWorker.startSession).not.toHaveBeenCalled();
  });

  it("rejects compressed images with pathological pixel dimensions", async () => {
    await expect(extractImageText(pngHeader(100_000, 100_000)))
      .rejects.toThrow("OCR image exceeds the 40 megapixel limit");
    expect(ocrWorker.startSession).not.toHaveBeenCalled();
  });

  it("accepts BITMAPCOREHEADER and top-down BITMAPINFOHEADER images", async () => {
    await expect(extractImageText(bmpCoreHeader())).resolves.toMatchObject({ text: "text" });
    await expect(extractImageText(bmpInfoHeader(1, -1))).resolves.toMatchObject({ text: "text" });
  });

  it("accepts every supported OCR image header", async () => {
    const images = [pngHeader(), jpegHeader(), gifHeader(), webpHeader(), bmpInfoHeader(), pbmHeader()];

    await expect(extractImageBatchText(images))
      .resolves.toHaveLength(images.length);
  });

  it("rejects OCR batches over the aggregate pixel budget", async () => {
    const images = Array.from({ length: 4 }, () => pngHeader(6_000, 6_000));

    await expect(extractImageBatchText(images))
      .rejects.toThrow("OCR batch exceeds the aggregate 120 megapixel limit");
    expect(ocrWorker.startSession).not.toHaveBeenCalled();
  });

  it("rejects negative BMP widths before starting OCR", async () => {
    await expect(extractImageText(bmpInfoHeader(-1, 1)))
      .rejects.toThrow("OCR image format or dimensions could not be validated");
    expect(ocrWorker.startSession).not.toHaveBeenCalled();
  });

  it("rejects OCR work beyond the bounded queue depth", async () => {
    let releaseRecognition!: (value: { data: { text: string; confidence: number } }) => void;
    const recognition = new Promise<{ data: { text: string; confidence: number } }>((resolve) => {
      releaseRecognition = resolve;
    });
    ocrWorker.recognize.mockReturnValue(recognition);

    const accepted = Array.from({ length: 4 }, () => extractImageText(pngHeader()));
    await vi.waitFor(() => expect(ocrWorker.startSession).toHaveBeenCalledTimes(1));
    await expect(extractImageBatchText(Array.from({ length: 26 }, () => pngHeader())))
      .rejects.toThrow("OCR batches are limited to 25 images");
    await expect(extractImageText(pngHeader()))
      .rejects.toThrow("OCR queue is full");

    releaseRecognition({ data: { text: "text", confidence: 95 } });
    await expect(Promise.all(accepted)).resolves.toHaveLength(4);
  });

  it("enforces one total deadline across an OCR batch", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    ocrWorker.recognize.mockImplementation(async () => {
      now = 5 * 60_000 + 1;
      return { data: { text: "text", confidence: 95 } };
    });

    await expect(extractImageBatchText([pngHeader(), pngHeader()]))
      .rejects.toThrow("OCR batch exceeded the 5 minute processing limit");
    expect(ocrWorker.recognize).toHaveBeenCalledTimes(1);
  });

  it("counts OCR worker setup against the processing deadline", async () => {
    vi.useFakeTimers();
    ocrWorker.startSession.mockReturnValue({
      ready: new Promise<never>(() => { /* Intentionally pending to exercise the setup deadline. */ }),
      recognize: ocrWorker.recognize,
      terminate: ocrWorker.terminate,
    });

    const extraction = extractImageText(pngHeader());
    await vi.waitFor(() => expect(ocrWorker.startSession).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(extraction).rejects.toThrow("OCR exceeded the 120 second processing limit");
    expect(ocrWorker.recognize).not.toHaveBeenCalled();
    expect(ocrWorker.terminate).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
