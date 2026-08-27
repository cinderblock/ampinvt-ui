import { openUrl } from '@tauri-apps/plugin-opener';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * A GitHub release body is markdown, so render it as markdown rather than
 * dumping the source into a <pre>. Raw HTML is deliberately left disabled —
 * react-markdown ignores it by default — so a release body can only ever
 * produce the elements mapped below.
 */

const components: Components = {
  // A link must never navigate the webview: this window has no back button and
  // no address bar, so following one would strand the user in GitHub. Hand the
  // URL to the system browser instead.
  a({ href, children }) {
    if (!href) return <>{children}</>;
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void openUrl(href);
        }}
      >
        {children}
      </a>
    );
  },

  // Notes sit inside a section that already owns an <h2>, so shift the release
  // body's headings down to keep the outline honest — and to stop a release
  // that opens with "# 0.4.0" from out-shouting the page.
  h1: 'h3',
  h2: 'h4',
  h3: 'h5',
  h4: 'h6',
  h5: 'h6',
  h6: 'h6',

  // Images would have to be fetched from the network, which this app otherwise
  // never does. Show the alt text instead.
  img: ({ alt }) => <em>{alt || 'image'}</em>,
};

export default function ReleaseNotes({ markdown }: { markdown: string }) {
  return (
    // The panel scrolls when notes are long, so it has to be reachable from the
    // keyboard — a scroll container that only responds to the wheel is a trap
    // for anyone not using a mouse.
    <div className="notes" role="region" aria-label="Release notes" tabIndex={0}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
