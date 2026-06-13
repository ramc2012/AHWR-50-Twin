const fs = require('fs');
const file = '/data/dashboard_layout.json';
if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    if (data.gauges) {
        data.gauges.forEach(g => {
            if (g.dataKey === 'htd_torque') {
                g.dataKey = 'SPP-Bar';
                g.label = 'SPP';
                g.unit = 'psi';
                g.min = 0;
                g.max = 5000;
                g.majorTicks = 5;
                changed = true;
            }
        });
    }
    if (changed) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        console.log("Updated HTD TORQUE to SPP in " + file);
    } else {
        console.log("No HTD TORQUE found in gauges.");
    }
} else {
    console.log(file + " not found.");
}
