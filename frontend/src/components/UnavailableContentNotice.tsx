import { ExternalLink } from 'lucide-react';
import { UI_COLORS } from '@/lib/colors';

/**
 * Notice shown instead of embedding content whose URL isn't safe to render
 * inline. Offers a new-tab link only when `href` is a vetted https URL
 * (see toSafeHttpsUrl in '@/lib/embedSafety').
 */
function UnavailableContentNotice({ href }: { href: string | null }) {
  return (
    <div
      className="rounded-lg p-4 text-sm"
      style={{
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: UI_COLORS.border.default,
        backgroundColor: UI_COLORS.background.hoverLight,
        color: UI_COLORS.text.muted,
      }}
    >
      <p>This content can't be displayed here.</p>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 mt-2 no-underline"
          style={{ color: UI_COLORS.text.body }}
        >
          <ExternalLink className="w-3 h-3" />
          Open content in a new tab
        </a>
      )}
    </div>
  );
}

export default UnavailableContentNotice;
