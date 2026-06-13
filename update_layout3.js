const fs = require('fs');
const file = '/data/dashboard_layout.json';
if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    
    // Hardcode the array to strictly 3 gauges as requested
    data.gauges = [
        { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
        { id: 'd2', label: 'SPP', dataKey: 'SPP-Bar', min: 0, max: 5000, unit: 'psi', color: '#fbbf24', gridWidth: 3, size: 160, majorTicks: 5, minorTicks: 4 },
        { id: 'd6', label: 'HTD RPM', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', gridWidth: 3, size: 160 }
    ];
    
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log("Forced layout to exactly 3 gauges in " + file);
} else {
    console.log(file + " not found.");
}
