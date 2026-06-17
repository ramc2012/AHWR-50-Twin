import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

// Persisted theme system. The chosen theme name lives in localStorage under
// `romii_theme`; the provider supplies the matching MUI theme to MUI's
// ThemeProvider and drives the page <body> background via CssBaseline overrides.
//
// Scope note: only the MUI palette + the CssBaseline body background are
// swapped here. The shell (Layout) reads theme.palette.background.* so its
// surfaces honor the theme; a per-component reskin of every dashboard page is
// intentionally out of scope.

const STORAGE_KEY = 'romii_theme';

// Shared typography for every theme.
const TYPOGRAPHY = { fontFamily: 'Inter, sans-serif' };

// Build a theme whose CssBaseline forces the page background to match the
// palette so switching themes visibly changes the page background.
function makeTheme(palette) {
    return createTheme({
        palette,
        typography: TYPOGRAPHY,
        components: {
            MuiCssBaseline: {
                styleOverrides: {
                    body: {
                        backgroundColor: palette.background.default,
                        color: palette.text?.primary,
                    },
                },
            },
        },
    });
}

// 1) control-dark — the CURRENT look. Default.
const controlDark = makeTheme({
    mode: 'dark',
    primary: { main: '#38bdf8' },
    background: { default: '#0f172a', paper: '#1e293b' },
});

// 2) hp-hmi — ISA-101 high-performance HMI: desaturated gray base, low chroma.
//    The calm operator theme; color is reserved for the alarm strip.
const hpHmi = makeTheme({
    mode: 'dark',
    primary: { main: '#7d93a8' },
    background: { default: '#262b2e', paper: '#30363b' },
    text: { primary: '#d6dbdf', secondary: '#9aa3aa' },
});

// 3) light — light mode.
const light = makeTheme({
    mode: 'light',
    primary: { main: '#0284c7' },
    background: { default: '#f1f5f9', paper: '#ffffff' },
    text: { primary: '#0f172a', secondary: '#475569' },
});

// 4) high-contrast — sunlight / accessibility.
const highContrast = makeTheme({
    mode: 'dark',
    primary: { main: '#00e5ff' },
    background: { default: '#000000', paper: '#0a0a0a' },
    text: { primary: '#ffffff', secondary: '#cbd5e1' },
});

// Ordered list so the switcher renders deterministically.
export const THEMES = [
    { name: 'control-dark', label: 'Control Dark', theme: controlDark },
    { name: 'hp-hmi', label: 'HP-HMI (ISA-101)', theme: hpHmi },
    { name: 'light', label: 'Light', theme: light },
    { name: 'high-contrast', label: 'High Contrast', theme: highContrast },
];

const THEME_MAP = THEMES.reduce((acc, t) => { acc[t.name] = t; return acc; }, {});
const DEFAULT_THEME = 'control-dark';

const ThemeModeContext = createContext(null);

function readStoredTheme() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && THEME_MAP[stored]) return stored;
    } catch (e) {
        // localStorage unavailable (private mode / SSR) — fall back to default.
    }
    return DEFAULT_THEME;
}

export const ThemeModeProvider = ({ children }) => {
    const [themeName, setThemeNameState] = useState(readStoredTheme);

    const setThemeName = useCallback((name) => {
        if (!THEME_MAP[name]) return;
        setThemeNameState(name);
        try {
            localStorage.setItem(STORAGE_KEY, name);
        } catch (e) {
            // Persisting is best-effort.
        }
    }, []);

    const activeTheme = THEME_MAP[themeName]?.theme || controlDark;

    const value = useMemo(() => ({
        themeName,
        setThemeName,
        themes: THEMES,
    }), [themeName, setThemeName]);

    return (
        <ThemeModeContext.Provider value={value}>
            <ThemeProvider theme={activeTheme}>
                <CssBaseline />
                {children}
            </ThemeProvider>
        </ThemeModeContext.Provider>
    );
};

export const useThemeMode = () => {
    const ctx = useContext(ThemeModeContext);
    if (!ctx) {
        throw new Error('useThemeMode must be used within a ThemeModeProvider');
    }
    return ctx;
};
