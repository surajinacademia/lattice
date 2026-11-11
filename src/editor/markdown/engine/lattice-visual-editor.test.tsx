/** Clean implementation for Lattice; spec: docs/visual-editor-spec.md */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Props = VisualMarkdownEditorProps;
type ChangeMock = ReturnType<typeof vi.fn<Props["onChangeMarkdown"]>>;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(props: Partial<Props> = {}) {
  const onChange: ChangeMock = vi.fn<Props["onChangeMarkdown"]>(() => true);
  let current: Props = { text: "Hello", activePath: "notes.md", onChangeMarkdown: onChange, onUndo: () => true, onRedo: () => true, ...props };
  const view = render(<LatticeVisualMarkdownEditor {...current} />);
  return {
    ...view,
    onChange: (props.onChangeMarkdown ?? onChange) as ChangeMock,
    rerender: (next: Partial<Props>) => view.rerender(<LatticeVisualMarkdownEditor {...(current = { ...current, ...next })} />),
    get editor() { return surface().editor; },
  };
}

/** Append `text` at the end of the text in top-level block `index`. */
function appendToBlock(editor: Editor, index: number, text: string) {
  let position = 0;
  editor.state.doc.forEach((node, offset, current) => {
    if (current === index) position = offset + node.nodeSize - 1;
  });
  editor.view.dispatch(editor.state.tr.insertText(text, position));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

/** The text of the first `selector` element in `color`, whichever of the two the editor nests outside. */
function coloredText(color: string, selector: string) {
  const within = `[data-lattice-color="${color}"]`;
  return Array.from(surface().querySelectorAll(selector)).find((node) => node.closest(within) ?? node.querySelector(within))?.textContent;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Lattice visual Markdown editor", () => {
  it("renders and edits the issue's colored prose without raw span chips or writes on open", async () => {
    const text = '<span style="color: blue">*New estimate:* $x=2$.</span>\n\n<span style="color: red">~~Old estimate.~~</span>';
    const view = renderEditor({ text });
    expect(coloredText("blue", "em")).toBe("New estimate:");
    await waitFor(() => expect(surface().querySelector('[data-lattice-color="blue"] .lx-md-math')?.getAttribute("data-formula")).toBe("x=2"));
    expect(coloredText("red", "s")).toBe("Old estimate.");
    expect(surface().querySelector<HTMLElement>('[data-lattice-color="blue"]')?.style.color).toBe("blue");
    expect(surface().querySelector(".lx-md-raw-inline")).toBeNull();
    expect(surface().textContent).not.toContain("<span");
    await settle();
    expect(view.onChange).not.toHaveBeenCalled();

    act(() => {
      view.editor.commands.setTextSelection({ from: 1, to: 13 });
      view.editor.commands.insertContent("Updated estimate");
    });
    const saved = text.replace("New estimate", "Updated estimate");
    await waitFor(() => expect(view.onChange).toHaveBeenCalledWith(saved, text));
    view.unmount();
    const reopened = renderEditor({ text: saved });
    expect(coloredText("blue", "em")).toBe("Updated estimate:");
    expect(coloredText("red", "s")).toBe("Old estimate.");
    await settle();
    expect(reopened.onChange).not.toHaveBeenCalled();
  });

  it("composes color with links, both math delimiters, and every supported prose mark", async () => {
    renderEditor({ text: '<span style="color: #3366cc">[review](https://example.test) $x=2$ \\(y=3\\) **bold** *italic* ~~strike~~ <u>underlined</u> ==highlighted== `code`</span>' });
    expect(coloredText("#3366cc", "a[href='https://example.test']")).toBe("review");
    await waitFor(() => expect(Array.from(surface().querySelectorAll('[data-lattice-color="#3366cc"] .lx-md-math'), (node) => node.getAttribute("data-formula"))).toEqual(["x=2", "y=3"]));
    for (const [tag, text] of [["strong", "bold"], ["em", "italic"], ["s", "strike"], ["u", "underlined"], ["mark", "highlighted"], ["code", "code"]]) {
      expect(coloredText("#3366cc", tag)).toBe(text);
    }
    expect(surface().querySelector(".lx-md-raw-inline")).toBeNull();
  });

  it("continues color at the trailing boundary but not before the run through publication and reopen", async () => {
    const text = 'before <span style="color: red">middle</span> after';
    const view = renderEditor({ text });
    act(() => {
      view.editor.view.dispatch(view.editor.state.tr.insertText("!", 14));
      view.editor.view.dispatch(view.editor.state.tr.insertText("?", 8));
    });
    const saved = 'before ?<span style="color: red">middle!</span> after';
    await waitFor(() => expect(view.onChange).toHaveBeenCalledWith(saved, text));
    view.unmount();
    renderEditor({ text: saved });
    expect(surface().querySelector('[data-lattice-color="red"]')?.textContent).toBe("middle!");
    expect(surface().textContent).toBe("before ?middle! after");
  });

  it("rereads color DOM without copying unrelated styles or event attributes", () => {
    const { editor } = renderEditor({ text: '<span style="color: #AbC">**note**</span>' });
    const container = document.createElement("div");
    const serializer = DOMSerializer.fromSchema(editor.schema);
    const parser = DOMParser.fromSchema(editor.schema);
    container.append(serializer.serializeFragment(editor.state.doc.content));
    expect(parser.parse(container).toJSON()).toEqual(editor.state.doc.toJSON());

    container.innerHTML = '<p><span data-lattice-color=" blue " style="color: red; background: yellow" onclick="alert(1)" title="discard">note</span></p>';
    const imported = parser.parse(container);
    expect(imported.firstChild?.firstChild?.marks.map((mark) => [mark.type.name, mark.attrs.color])).toEqual([["latticeColor", "blue"]]);
    container.replaceChildren(serializer.serializeFragment(imported.content));
    const span = container.querySelector("span")!;
    expect(span.getAttributeNames().sort()).toEqual(["data-lattice-color", "style"]);
    expect(span.style.length).toBe(1);
    expect(span.style.color).toBe("blue");

    for (const html of [
      '<span data-lattice-color="var(--x)">note</span>', '<span data-lattice-color="red; background: yellow">note</span>',
      '<span data-lattice-color="notAColor">note</span>', '<span style="color: blue">note</span>',
    ]) {
      container.innerHTML = `<p>${html}</p>`;
      expect(parser.parse(container).firstChild?.firstChild?.marks).toEqual([]);
    }
  });

  it("renders Markdown visually, keeps unmodelled source verbatim, and never writes on open", async () => {
    const { onChange } = renderEditor({ text: "# Title\n\n- one\n- two\n\n<Tabs mode=\"x\">\n\nBody\n\n</Tabs>\n" });
    expect(surface().querySelector("h1")?.textContent).toBe("Title");
    expect(surface().querySelectorAll("li")).toHaveLength(2);
    const raw = await screen.findByRole("group", { name: "Unknown component: Tabs" });
    expect(raw.querySelector("pre")?.textContent).toBe("<Tabs mode=\"x\">\n\nBody\n\n</Tabs>");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("publishes one edit and keeps every untouched byte", async () => {
    const text = "## Contents\n- one\n\nClosing prose.\n";
    const { editor, onChange } = renderEditor({ text });
    appendToBlock(editor, 2, "!");
    appendToBlock(editor, 2, "?");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith("## Contents\n- one\n\nClosing prose.!?\n", text);
  });

  it("keeps the BOM and CRLF envelope on edit", async () => {
    const text = "\uFEFF# Title\r\n\r\nBody\r\n";
    const { editor, onChange } = renderEditor({ text });
    appendToBlock(editor, 1, " text");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("\uFEFF# Title\r\n\r\nBody text\r\n", text));
  });

  it("declines a file with mixed line endings: read-only, with a notice, and no writes", async () => {
    const { onChange } = renderEditor({ text: "One\r\n\r\nTwo\n" });
    expect(await screen.findByText(/Visual editing is unavailable/)).toBeInTheDocument();
    expect(surface().getAttribute("contenteditable")).toBe("false");
    expect(surface().textContent).toContain("Two");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports eligibility to a host that places the notice itself", async () => {
    const onEligibilityChange = vi.fn();
    renderEditor({ text: "a\rb", onEligibilityChange });
    await waitFor(() => expect(onEligibilityChange).toHaveBeenLastCalledWith(expect.stringMatching(/unavailable/)));
    expect(screen.queryByText(/Visual editing is unavailable/)).toBeNull();
  });

  it("adopts canonical text from the host without publishing, and ignores its own echo", async () => {
    const view = renderEditor({ text: "First\n" });
    view.rerender({ text: "Second\n" });
    await waitFor(() => expect(surface().textContent).toBe("Second"));
    appendToBlock(view.editor, 0, " edit");
    await waitFor(() => expect(view.onChange).toHaveBeenCalledWith("Second edit\n", "Second\n"));
    const before = view.editor.state.doc;
    view.rerender({ text: "Second edit\n" });
    await settle();
    expect(view.editor.state.doc).toBe(before);
    expect(view.onChange).toHaveBeenCalledTimes(1);
  });

  it("delegates undo and redo to the host after publishing the pending edit", async () => {
    const onUndo = vi.fn(() => true);
    const onRedo = vi.fn(() => true);
    const { editor, onChange } = renderEditor({ text: "Hello\n", onUndo, onRedo });
    appendToBlock(editor, 0, "!");
    editor.commands.keyboardShortcut("Mod-z");
    expect(onChange).toHaveBeenCalledWith("Hello!\n", "Hello\n");
    expect(onUndo).toHaveBeenCalledTimes(1);
    editor.commands.keyboardShortcut("Mod-Shift-z");
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("publishes an edit made during a long IME composition once the composition ends", async () => {
    const { editor, onChange } = renderEditor({ text: "Hello\n" });
    fireEvent.compositionStart(surface());
    appendToBlock(editor, 0, " 世界");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(surface());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Hello 世界\n", "Hello\n"));
  });

  it("hands the host a synchronous flush and withdraws it on unmount", () => {
    const registrations: ((() => boolean) | null)[] = [];
    const view = renderEditor({ text: "Hello\n", onFlushPendingChange: (flush) => registrations.push(flush) });
    appendToBlock(view.editor, 0, " world");
    expect(registrations[0]?.()).toBe(true);
    expect(view.onChange).toHaveBeenCalledWith("Hello world\n", "Hello\n");
    view.unmount();
    expect(registrations.at(-1)).toBeNull();
  });

  it("publishes a pending edit for the previous file when the path switches", async () => {
    const publishA = vi.fn<Props["onChangeMarkdown"]>(() => true);
    const publishB = vi.fn<Props["onChangeMarkdown"]>(() => true);
    const view = renderEditor({ text: "Alpha\n", activePath: "a.md", onChangeMarkdown: publishA });
    appendToBlock(view.editor, 0, " edit");
    view.rerender({ text: "Beta\n", activePath: "b.md", onChangeMarkdown: publishB });
    await waitFor(() => expect(surface().textContent).toBe("Beta"));
    expect(publishA).toHaveBeenCalledWith("Alpha edit\n", "Alpha\n");
    expect(publishB).not.toHaveBeenCalled();
  });

  it("rebases a rejected draft over a disjoint canonical edit", async () => {
    const onChangeMarkdown = vi.fn<Props["onChangeMarkdown"]>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const view = renderEditor({ text: "Alpha middle Omega\n", onChangeMarkdown });
    appendToBlock(view.editor, 0, " tail");
    await waitFor(() => expect(onChangeMarkdown).toHaveBeenCalledWith("Alpha middle Omega tail\n", "Alpha middle Omega\n"));
    view.rerender({ text: "Prefix Alpha middle Omega\n" });
    await waitFor(() => expect(onChangeMarkdown).toHaveBeenLastCalledWith("Prefix Alpha middle Omega tail\n", "Prefix Alpha middle Omega\n"));
    expect(surface().textContent).toBe("Prefix Alpha middle Omega tail");
  });

  // A note the host refused (its annotations not read yet) must stay in the
  // composer, or the typed text is lost while the host says to try again.
  it("keeps the comment composer and its text when the host refuses the note", async () => {
    const onCreateComment = vi.fn();
    const { editor } = renderEditor({ text: "Hello\n", onCreateComment });
    act(() => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6)));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Clarify." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
    expect(onCreateComment).toHaveBeenCalledWith(0, 5, "Clarify.", expect.any(Function));
    expect(screen.getByRole("dialog", { name: "Add comment" })).toBeInTheDocument();
    expect(within(composer).getByRole("textbox", { name: "Comment" })).toHaveValue("Clarify.");
  });

  // Each report re-renders App; a drag changes the selection on every move (#777).
  it("reports a selection being dragged out once, when the press ends", () => {
    const onCaretChange = vi.fn();
    const onSelectionMarkdown = vi.fn();
    const { editor } = renderEditor({ text: "Hello world\n", onCaretChange, onSelectionMarkdown });
    fireEvent.pointerDown(surface(), { button: 0 });
    for (const to of [3, 6, 9]) {
      act(() => {
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, to)));
      });
    }
    expect(onSelectionMarkdown).not.toHaveBeenCalled();
    expect(onCaretChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onSelectionMarkdown).toHaveBeenCalledExactlyOnceWith("Hello wo");
    expect(onCaretChange).toHaveBeenCalledExactlyOnceWith(0, 8);
  });

  it("keeps a read-only document read-only", () => {
    renderEditor({ text: "Hello\n", editable: false });
    expect(surface().getAttribute("contenteditable")).toBe("false");
  });
});
