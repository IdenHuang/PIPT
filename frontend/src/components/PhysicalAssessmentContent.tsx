import { useMemo, useState } from 'react';
import { UI_COLORS } from '@/lib/colors';
import { ZoomIn, ZoomOut, RotateCcw, ExternalLink } from 'lucide-react';
import type { PersonaMedia } from '@/services/studentService';
import {
  extractSafeIframeSrc,
  isEmbedCode,
  sanitizeEmbedCode,
  toAllowedIframeSrc,
  toSafeHttpsUrl,
} from '@/lib/embedSafety';
import UnavailableContentNotice from '@/components/UnavailableContentNotice';

interface PhysicalAssessmentContentProps {
  materials: PersonaMedia[];
  loading?: boolean;
}


/**
 * Extract width and height from an iframe's attributes to compute aspect ratio.
 * Returns the aspect ratio as a CSS string (e.g., "16 / 9") or null if not determinable.
 */
function extractAspectRatio(html: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const iframe = doc.querySelector('iframe');
  if (!iframe) return null;

  const width = parseInt(iframe.getAttribute('width') || '', 10);
  const height = parseInt(iframe.getAttribute('height') || '', 10);

  if (width > 0 && height > 0) {
    return `${width} / ${height}`;
  }

  return null;
}

/**
 * Returns true when the given filename/url points to a raster or vector image
 * that should be rendered inline with <img> (resizable) rather than an <iframe>.
 */
export function isImageFile(nameOrUrl: string): boolean {
  const path = nameOrUrl.split('?')[0].split('#')[0].toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(path);
}

/**
 * Renders a zoomable image with zoom in/out/reset controls.
 */
export function ImageViewer({ url, title }: { url: string; title: string }) {
  const [scale, setScale] = useState(1);

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 4));
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));
  const resetZoom = () => setScale(1);

  // Only https URLs reach the <img src> / <a href> sinks.
  const safeUrl = toSafeHttpsUrl(url);
  if (!safeUrl) {
    return <UnavailableContentNotice href={null} />;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={zoomOut}
          className="p-1.5 rounded transition-colors"
          style={{ backgroundColor: UI_COLORS.background.hoverLight, border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" style={{ color: UI_COLORS.text.body }} />
        </button>
        <span className="text-xs min-w-[3rem] text-center" style={{ color: UI_COLORS.text.muted }}>
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={zoomIn}
          className="p-1.5 rounded transition-colors"
          style={{ backgroundColor: UI_COLORS.background.hoverLight, border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" style={{ color: UI_COLORS.text.body }} />
        </button>
        <button
          onClick={resetZoom}
          className="p-1.5 rounded transition-colors"
          style={{ backgroundColor: UI_COLORS.background.hoverLight, border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
          aria-label="Reset zoom"
        >
          <RotateCcw className="w-4 h-4" style={{ color: UI_COLORS.text.body }} />
        </button>
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded transition-colors ml-auto"
          style={{ backgroundColor: UI_COLORS.background.hoverLight, cursor: 'pointer' }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
          aria-label="Open image in new tab"
        >
          <ExternalLink className="w-4 h-4" style={{ color: UI_COLORS.text.body }} />
        </a>
      </div>
      <div
        className="rounded-lg overflow-auto"
        style={{
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: UI_COLORS.border.default,
          maxHeight: '500px',
        }}
      >
        <img
          src={safeUrl}
          alt={title}
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            transition: 'transform 0.2s ease',
            display: 'block',
            maxWidth: scale <= 1 ? '100%' : 'none',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Renders a single embed — either from raw embed HTML or a plain URL.
 */
function EmbedRenderer({ url, title }: { url: string; title: string }) {
  const embedCode = isEmbedCode(url);
  const { sanitizedHtml, aspectRatio } = useMemo(() => {
    if (embedCode) {
      const sanitized = sanitizeEmbedCode(url);
      const ratio = extractAspectRatio(url);
      return { sanitizedHtml: sanitized, aspectRatio: ratio };
    }
    return { sanitizedHtml: null, aspectRatio: null };
  }, [url, embedCode]);

  // Embed code path — render sanitized HTML in a responsive container
  if (sanitizedHtml) {
    return (
      <div
        className="embed-responsive rounded-lg overflow-hidden w-full"
        style={{
          position: 'relative',
          aspectRatio: aspectRatio || '16 / 9',
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: UI_COLORS.border.default,
        }}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }

  // Embed code that couldn't be sanitized/rendered (e.g. its domain isn't
  // allowlisted). Never fall through to the plain-URL <iframe> below — that
  // would put the raw embed HTML into the src attribute and 404. Show a notice
  // with a link to open the source directly, if we can recover it.
  if (embedCode) {
    return <UnavailableContentNotice href={extractSafeIframeSrc(url)} />;
  }

  // Plain URL path: only an https URL on an allowlisted embed host may become
  // an iframe src. Anything else (javascript:, data:, http:, unknown hosts)
  // gets the notice, with a new-tab link only if it is at least https.
  const iframeSrc = toAllowedIframeSrc(url);
  if (!iframeSrc) {
    return <UnavailableContentNotice href={toSafeHttpsUrl(url)} />;
  }

  // Render in a 16:9 iframe wrapper (legacy behavior)
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        position: 'relative',
        width: '100%',
        paddingBottom: '56.25%',
        height: 0,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: UI_COLORS.border.default,
      }}
    >
      <iframe
        src={iframeSrc}
        title={title}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          border: 0,
        }}
        allowFullScreen
        allow="autoplay *; fullscreen *; encrypted-media *"
        sandbox="allow-downloads allow-forms allow-same-origin allow-scripts allow-top-navigation allow-pointer-lock allow-popups allow-modals allow-orientation-lock allow-popups-to-escape-sandbox allow-presentation allow-top-navigation-by-user-activation"
      />
    </div>
  );
}

function PhysicalAssessmentContent({ materials, loading }: PhysicalAssessmentContentProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>Loading materials...</p>
      </div>
    );
  }

  const materialsWithContent = materials.filter((material) => material.url?.trim());

  if (materialsWithContent.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>No physical assessment materials available.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {materialsWithContent.map((material) => (
        <div key={material.media_id} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold" style={{ color: UI_COLORS.text.heading }}>
              {material.title}
            </h3>
            {material.media_type !== 'image' && !isEmbedCode(material.url) && toSafeHttpsUrl(material.url) && (
              <a
                href={toSafeHttpsUrl(material.url)!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors no-underline"
                style={{ backgroundColor: UI_COLORS.background.hoverLight, color: UI_COLORS.text.body }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
              >
                <ExternalLink className="w-3 h-3" />
                Open in new tab
              </a>
            )}
          </div>
          {material.description && (
            <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>
              {material.description}
            </p>
          )}
          {material.url && (
            material.media_type === 'image' ? (
              <ImageViewer url={material.url} title={material.title} />
            ) : (
              <EmbedRenderer url={material.url} title={material.title} />
            )
          )}
        </div>
      ))}
    </div>
  );
}

export default PhysicalAssessmentContent;
