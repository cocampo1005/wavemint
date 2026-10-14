import { useState } from "react";
import { artworkUrl } from "./format";
import { ARTWORK_PLACEHOLDER } from "./placeholder";

/**
 * Album artwork, or the shared placeholder when there's none (no hash or
 * src), or when the image fails to load (missing, undecodable, request
 * failed). `src` (e.g. a data: preview) takes precedence over `hash`.
 */
export function Artwork({ hash = null, src = "", size = 160, className = "", alt = "", ...rest }) {
  const url = src || artworkUrl(hash, size);
  const [failed, setFailed] = useState("");
  if (!url || failed === url) {
    return <img className={`${className} lib-art-placeholder`.trim()} src={ARTWORK_PLACEHOLDER} alt={alt} draggable={false} {...rest} />;
  }
  return <img className={className || undefined} src={url} alt={alt} onError={() => setFailed(url)} {...rest} />;
}
