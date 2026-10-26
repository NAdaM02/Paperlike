import { messages } from "./copy/messages";
import { Modal } from "./ui";

type Row = { keys: string; action: string };

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="shortcuts-group">
      <h3 className="shortcuts-group-title">{title}</h3>
      <ul className="shortcuts-list">
        {rows.map((r) => (
          <li key={`${title}-${r.keys}`}>
            <kbd className="shortcuts-keys">{r.keys}</kbd>
            <span>{r.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={messages.shortcutsTitle} onClose={onClose} wide>
      <div className="shortcuts-sheet">
        <Group
          title="File"
          rows={[
            { keys: "Ctrl+S", action: "Save" },
            { keys: "Ctrl+Z", action: "Undo" },
            { keys: "Ctrl+Y", action: "Redo" },
          ]}
        />
        <Group
          title="Navigate"
          rows={[
            { keys: "Ctrl+Shift+F", action: "Search everywhere" },
            { keys: "Ctrl+J", action: "Ask" },
            { keys: "Alt+← / Alt+→", action: "Back / forward" },
          ]}
        />
        <Group
          title="Draw"
          rows={[
            { keys: "V / Esc", action: "Select" },
            { keys: "S", action: "Lasso" },
            { keys: "P", action: "Pen" },
            { keys: "H", action: "Marker" },
            { keys: "E", action: "Eraser" },
            { keys: "R / O / L / A", action: "Rect / ellipse / line / arrow" },
            { keys: "Shift", action: "Straight ink and constrained shapes" },
          ]}
        />
        <Group
          title="View"
          rows={[
            { keys: "F11", action: "Full screen" },
            { keys: "Esc", action: "Leave full screen" },
          ]}
        />
        <Group
          title="PDF preview"
          rows={[
            { keys: "Shift+click", action: "Pick images on the page" },
            { keys: "Shift", action: "Move locked items" },
            { keys: "Drag pages", action: "Reorder joined pages" },
            { keys: "Right-click", action: "Lock or unlock position" },
          ]}
        />
      </div>
    </Modal>
  );
}
