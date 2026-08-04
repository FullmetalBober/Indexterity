import { describe, expect, it } from "vitest";
import { requestKind } from "./requests";

// Three kinds, and the boundaries between them are the whole content of this
// decision: a page render, an in-process function call over HTTP, and a static
// file mean different things when they are slow.
describe("classifying a request", () => {
  it("reads a server function call from its base path", () => {
    expect(requestKind("/_serverFn/9f2ca1")).toBe("server_fn");
  });

  it("reads build output as an asset", () => {
    expect(requestKind("/_build/assets/app-a1b2c3.js")).toBe("asset");
  });

  it("treats a page as a document", () => {
    expect(requestKind("/")).toBe("document");
    expect(requestKind("/app/org")).toBe("document");
  });

  // The extension heuristic that was here first called this an asset. It is not:
  // no such file exists, so the router answered it with a 404 document, and
  // filing it under assets would have hidden a class of 404 in the one bucket
  // nobody looks at.
  it("treats a bogus path with an extension as the document it was answered with", () => {
    expect(requestKind("/wp-login.php")).toBe("document");
    expect(requestKind("/.env")).toBe("document");
  });
});
