import React, { useState } from 'react';
import { Box, Typography } from '@mui/material';

// ONGC brand lockup.
//
// The mark is loaded from /ongc-logo.svg (frontend/public/) and the corporate
// tagline from /ongc-tagline.svg. To use the OFFICIAL vector assets, replace
// those files — no code change needed. If an asset is missing/fails to load we
// fall back to a neutral wordmark so the shell never shows a broken image.
//
// The wordmark is a red→green gradient designed for a light ground, so it is
// placed on a white chip when used on the dark app shell.

export const ONGC_RED = '#B02128';
export const ONGC_GREEN = '#00A44F';

/** Just the "ongc" wordmark, scaled by height. */
export function OngcMark({ height = 30, plate = true }) {
    const [failed, setFailed] = useState(false);
    const inner = failed ? (
        <Typography
            aria-label="ONGC"
            sx={{
                fontWeight: 800, fontSize: height * 0.78, lineHeight: 1, letterSpacing: -1,
                background: `linear-gradient(90deg, ${ONGC_RED}, ${ONGC_GREEN})`,
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}
        >
            ongc
        </Typography>
    ) : (
        <Box
            component="img"
            src="/ongc-logo.svg"
            alt="ONGC"
            onError={() => setFailed(true)}
            sx={{ height, width: 'auto', display: 'block', objectFit: 'contain' }}
        />
    );

    if (!plate) return inner;
    return (
        <Box sx={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            bgcolor: '#ffffff', borderRadius: 1.25, px: height * 0.28, py: height * 0.16,
            flex: '0 0 auto', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
        }}>
            {inner}
        </Box>
    );
}

/** Corporate tagline strip (login page). */
export function OngcTagline({ height = 20 }) {
    const [failed, setFailed] = useState(false);
    if (failed) return null;
    return (
        <Box
            component="img"
            src="/ongc-tagline.svg"
            alt="ENERGY: Now AND Next"
            onError={() => setFailed(true)}
            sx={{ height, width: 'auto', display: 'block', objectFit: 'contain' }}
        />
    );
}

/**
 * Brand lockup: ONGC wordmark + product name.
 * @param {number}  size     wordmark height in px
 * @param {boolean} showText hide the product line when the rail is collapsed
 */
export default function OngcBrand({ size = 26, showText = true, product = 'AHWR-50 Twin', large = false, onClick, title }) {
    const clickable = typeof onClick === 'function';
    return (
        <Box
            onClick={onClick}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(e); } : undefined}
            title={title}
            sx={{
                display: 'flex', alignItems: 'center', gap: large ? 2 : 1.25, minWidth: 0,
                cursor: clickable ? 'pointer' : 'default',
                '&:hover': clickable ? { opacity: 0.88 } : undefined,
            }}
        >
            <OngcMark height={size} />
            {showText && (
                <Box sx={{ minWidth: 0, lineHeight: 1.1 }}>
                    <Typography noWrap sx={{ fontSize: large ? 15 : 12.5, fontWeight: 700, letterSpacing: 0.4, color: '#e2e8f0', lineHeight: 1.25 }}>
                        {product}
                    </Typography>
                    <Typography noWrap sx={{ fontSize: large ? 12 : 9.5, fontWeight: 600, letterSpacing: 0.8, color: '#64748b', lineHeight: 1.25, textTransform: 'uppercase' }}>
                        Workover Digital Twin
                    </Typography>
                </Box>
            )}
        </Box>
    );
}
