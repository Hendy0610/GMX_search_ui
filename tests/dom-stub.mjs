import { readFileSync } from "node:fs";

// A DOM small enough to read, big enough to prove the escaping rule.
//
// `createPageStub` additionally reads the real index.html so that a test can
// check the application against the ids the page actually has.
//
// jsdom would work, but it is a dependency, and the property under test here is
// narrow: does the rendering code put untrusted strings in as *text*? A stub
// answers that better than a real DOM would, because it cannot parse HTML at
// all - so if a test finds an element that the code did not explicitly create,
// something built it from a string, which is exactly the bug being hunted.

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this._text = "";
    // Handlers are kept so a test can invoke one the way the browser would.
    // The stub dispatches nothing by itself; a test that wants a change event
    // calls the handler and says so.
    this.listeners = {};
  }

  set textContent(value) {
    // Text, never markup. The stub stores the string verbatim and creates no
    // children from it - the same observable behaviour as the real thing.
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    if (this.children.length) {
      return this._text + this.children.map((child) => child.textContent).join("");
    }
    return this._text;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
    this._text = "";
  }

  insertBefore(node, reference) {
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at < 0) {
      this.children.push(node);
    } else {
      this.children.splice(at, 0, node);
    }
    return node;
  }

  /** Focus, recorded so a test can ask what the application focused. */
  focus() {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }

  /** Fire a recorded handler the way the browser would. */
  dispatch(type, event = {}) {
    this.listeners[type]?.({ preventDefault() {}, ...event });
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  /** Depth-first walk, for assertions. */
  *walk() {
    yield this;
    for (const child of this.children) {
      yield* child.walk();
    }
  }

  /** Every element tag present in this subtree. */
  tags() {
    return [...this.walk()].map((node) => node.tagName);
  }

  /** All text in this subtree, concatenated. */
  allText() {
    return [...this.walk()].map((node) => node._text).join("");
  }
}

class StubText extends StubNode {
  constructor(value) {
    super("#text");
    this._text = String(value);
  }
}

export function createStubDocument() {
  const byId = new Map();
  const body = new StubNode("body");
  return {
    body,
    //: What `focus()` last landed on. The real thing is read-only; here it is
    //: simply recorded, which is all a test needs to ask.
    activeElement: null,
    createElement: (tag) => new StubNode(tag),
    createTextNode: (value) => new StubText(value),
    getElementById: (id) => byId.get(id) ?? null,
    _register(id, node) {
      byId.set(id, node);
      return node;
    },
  };
}

/**
 * A stub document carrying exactly the ids that index.html carries.
 *
 * Built by scanning the real markup rather than from a hand-written list, and
 * that is the whole point. A hand-written list drifts: the application can
 * start addressing an element the page does not have, every test still passes,
 * and the failure surfaces in a browser. Scanning the file means the tests see
 * the same set of ids the browser will.
 *
 * The nodes are stubs, so this proves wiring - "app.js addresses ids that
 * exist" - not layout. Whether the element is *visible* is a browser question,
 * and is checked in a browser.
 */
export function createPageStub(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const doc = createStubDocument();
  const ids = [];
  // Each opening tag, whole, so the tag name and the attributes on it are read
  // from the same element rather than guessed at.
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const [, tag, attrs] = match;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (!id) {
      continue;
    }
    ids.push(id);
    const node = new StubNode(tag);
    node.ownerDocument = doc;
    node.setAttribute("id", id);
    node.value = "";
    node.checked = false;
    node.disabled = /\bdisabled\b/.test(attrs);
    node.hidden = /\bhidden\b/.test(attrs);
    doc._register(id, node);
    doc.body.appendChild(node);
  }
  return { doc, ids };
}

export { StubNode };
