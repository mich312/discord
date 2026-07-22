import React, { useMemo } from 'react';
import qrcode from 'qrcode-generator';

// A scannable QR for a URL. Always dark-on-white regardless of app theme —
// scanners need contrast — set on its own white card by the caller.
// Error-correction 'L': the link is long, and low EC keeps the version (and
// module density) down, which reads more reliably on a phone camera.
export default function Qr({ url, size = 232 }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const margin = 4;
    const dim = n + margin * 2;
    let rects = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) rects += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
      `width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="Sign-in QR code">` +
      `<rect width="${dim}" height="${dim}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`
    );
  }, [url, size]);

  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}
