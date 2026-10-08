import { Popover } from "@base-ui/react/popover";
import { List } from "lucide-react";

interface OutlineItem {
  id: string;
  text: string;
  level: number;
}

interface OutlineProps {
  items: readonly OutlineItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  closeOnJump?: boolean;
}

/** The same heading list serves the side rail and compact popover. */
export function ReaderOutline({ items, activeId, onJump, closeOnJump }: OutlineProps) {
  return (
    <ul className="outline-list">
      {items.map((item) => {
        const button = (
          <button
            type="button"
            className="outline-link"
            aria-current={activeId === item.id ? "location" : undefined}
            onClick={() => onJump(item.id)}
          >
            {item.text}
          </button>
        );
        return (
          <li key={item.id} className={`outline-item lvl-${item.level}${activeId === item.id ? " is-active" : ""}`}>
            {closeOnJump ? <Popover.Close render={button} /> : button}
          </li>
        );
      })}
    </ul>
  );
}

/** Available at the article header whenever the context rail stacks. */
export function CompactReaderOutline(props: OutlineProps) {
  return (
    <div className="reader-compact-outline">
      <Popover.Root>
        <Popover.Trigger render={<button type="button" className="reader-outline-trigger" />}>
          <List size={14} aria-hidden="true" />
          On this page
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="ui-popover-positioner" side="bottom" align="start" sideOffset={6}>
            <Popover.Popup className="ui-popover reader-outline-popup" aria-label="On this page">
              <Popover.Title className="rail-title">On this page</Popover.Title>
              <nav aria-label="Page sections">
                <ReaderOutline {...props} closeOnJump />
              </nav>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
