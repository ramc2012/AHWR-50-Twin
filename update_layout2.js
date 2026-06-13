const fs = require('fs');
const file = '/data/dashboard_layout.json';
if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    if (data.gauges) {
        data.gauges.forEach(g => {
            if (g.dataKey === 'wob') {
                g.dataKey = 'SPP-Bar';
                g.label = 'SPP';
                g.unit = 'psi';
                g.min = 0;
                g.max = 5000;
                g.majorTicks = 5;
                g.minorTicks = 4;
                changed = true;
            } else if (g.dataKey === 'SPP-Bar' && g.label === 'SPP' && changed === false) {
                // If it was already SPP from my previous script, change it back to HTD TORQUE
                g.dataKey = 'htd_torque';
                g.label = 'HTD TORQUE';
                g.unit = 'Nm';
                g.min = 0;
                g.max = 1000;
                g.majorTicks = 5;
                changed = true;
            }
        });
        
        // Final sanity check: if any gauge is SPP, and another is also SPP, fix it.
        // Let's just overwrite the first 4 to be exact.
        data.gauges = [
            { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
            { id: 'd2', label: 'SPP', dataKey: 'SPP-Bar', min: 0, max: 5000, unit: 'psi', color: '#fbbf24', gridWidth: 3, size: 160, majorTicks: 5, minorTicks: 4 },
            { id: 'd6', label: 'HTD RPM', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', gridWidth: 3, size: 160 },
            { id: 'd7', label: 'HTD TORQUE', dataKey: 'htd_torque', min: 0, max: 1000, unit: 'Nm', color: '#fbbf24', gridWidth: 3, size: 160 }
        ];
        changed = true;
    }
    if (changed) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        console.log("Forced layout to WOH, SPP, HTD RPM, HTD TORQUE in " + file);
    }
} else {
    console.log(file + " not found.");
}
