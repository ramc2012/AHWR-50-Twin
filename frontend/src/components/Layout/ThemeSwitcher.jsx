import React, { useState } from 'react';
import { IconButton, Menu, MenuItem, ListItemIcon, ListItemText, Tooltip } from '@mui/material';
import { Palette, Check } from 'lucide-react';
import { useThemeMode } from '../../context/ThemeModeContext';

// Theme switcher: a Palette icon button in the AppBar that opens a Menu listing
// the available themes with the active one checked. Selecting applies + persists
// immediately (persistence handled by ThemeModeContext).
export default function ThemeSwitcher() {
    const { themeName, setThemeName, themes } = useThemeMode();
    const [anchorEl, setAnchorEl] = useState(null);
    const open = Boolean(anchorEl);

    const handleOpen = (e) => setAnchorEl(e.currentTarget);
    const handleClose = () => setAnchorEl(null);

    const handleSelect = (name) => {
        setThemeName(name);
        handleClose();
    };

    return (
        <>
            <Tooltip title="Change theme">
                <IconButton
                    onClick={handleOpen}
                    aria-label="Change theme"
                    aria-haspopup="true"
                    aria-expanded={open ? 'true' : undefined}
                    sx={{ color: '#94a3b8', '&:hover': { color: '#38bdf8', bgcolor: 'rgba(56,189,248,0.1)' } }}
                >
                    <Palette size={20} />
                </IconButton>
            </Tooltip>
            <Menu
                anchorEl={anchorEl}
                open={open}
                onClose={handleClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
                {themes.map((t) => {
                    const selected = t.name === themeName;
                    return (
                        <MenuItem key={t.name} selected={selected} onClick={() => handleSelect(t.name)}>
                            <ListItemIcon sx={{ minWidth: 32 }}>
                                {selected ? <Check size={16} /> : null}
                            </ListItemIcon>
                            <ListItemText primary={t.label} />
                        </MenuItem>
                    );
                })}
            </Menu>
        </>
    );
}
