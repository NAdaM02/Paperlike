import { ControlsOverview } from "./ControlsPanel";
import { messages } from "./copy/messages";
import { Modal } from "./ui";

/** The ? sheet: the same read-only overview as Settings, Controls. */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={messages.shortcutsTitle} onClose={onClose} wide>
      <ControlsOverview />
      <p className="settings-hint controls-sheet-hint">Change these in Settings, Controls.</p>
    </Modal>
  );
}