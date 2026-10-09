import { expect, it } from "vitest";
import { pdfImageRgba, pdfPageMarkdown } from "../source-pdf-images";
it("PDF RGB and packed monochrome rows become opaque RGBA pixels", () => {
  expect([...pdfImageRgba({ width: 1, height: 1, kind: 2, data: new Uint8Array([20, 30, 40]) })]).toEqual([20, 30, 40, 255]);
  const pixels = pdfImageRgba({ width: 3, height: 2, kind: 1, data: new Uint8Array([0b10100000, 0b01000000]) });
  expect([...pixels.filter((_, index) => index % 4 === 0)]).toEqual([255, 0, 255, 0, 255, 0]);
});
it("transparent pixels survive conversion", () => {
  expect([...pdfImageRgba({ width: 1, height: 1, kind: 3, data: new Uint8Array([10, 20, 30, 0]) })]).toEqual([10, 20, 30, 0]);
});
it("PDF images divide surrounding paragraphs at their page position", () => {
  const item = (str: string, y: number) => ({ str, transform: [12, 0, 0, 12, 10, y], width: 30, height: 12, hasEOL: true });
  expect(pdfPageMarkdown([item("Before", 800), item("After", 600)], [{ top: 720, left: 10, markdown: "![diagram](/image)" }])).toBe("Before\n\n![diagram](/image)\n\nAfter");
  expect(pdfPageMarkdown([], [{ top: 720, left: 10, markdown: "![scan](/image)" }])).toContain("![scan]");
});
