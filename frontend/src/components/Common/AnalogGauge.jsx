import React from 'react';
import { Box, Typography } from '@mui/material';

const AnalogGauge = ({
    value,
    min = 0,
    max = 100,
    label,
    unit,
    size = 200,
    startAngle = -135,
    endAngle = 135,
    majorTicks = 5,
    minorTicks = 4,
    color = '#38bdf8', // Default Cyan
    criticalLevel = 0.8, // 80%
    subValue,
    subLabel
}) => {
    // Calculations
    const radius = size / 2;
    const center = size / 2;
    const range = endAngle - startAngle;
    const valueRatio = Math.min(Math.max((value - min) / (max - min), 0), 1);
    const angle = startAngle + (valueRatio * range);

    // Polar to Cartesian
    const polarToCartesian = (centerX, centerY, radius, angleInDegrees) => {
        const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
        return {
            x: centerX + (radius * Math.cos(angleInRadians)),
            y: centerY + (radius * Math.sin(angleInRadians))
        };
    };

    // Generate Ticks
    const ticks = [];
    const tickStep = (max - min) / majorTicks;

    for (let i = 0; i <= majorTicks; i++) {
        const tickValue = min + (i * tickStep);
        const tickRatio = (tickValue - min) / (max - min);
        const tickAngle = startAngle + (tickRatio * range);

        // Major Tick
        const p1 = polarToCartesian(center, center, radius - 10, tickAngle);
        const p2 = polarToCartesian(center, center, radius - 22, tickAngle);

        ticks.push(
            <line
                key={`major-${i}`}
                x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                stroke="white" strokeWidth="2"
            />
        );

        // Text Label for Tick
        const textPos = polarToCartesian(center, center, radius - (size * 0.18), tickAngle);
        ticks.push(
            <text
                key={`text-${i}`}
                x={textPos.x} y={textPos.y}
                textAnchor="middle" alignmentBaseline="middle"
                fill="#94a3b8" fontSize={size * 0.06} fontWeight="bold"
            >
                {Math.round(tickValue)}
            </text>
        );

        // Minor Ticks between this major and the next
        if (i < majorTicks && minorTicks > 0) {
            const nextTickValue = min + ((i + 1) * tickStep);
            const minorStep = (nextTickValue - tickValue) / (minorTicks + 1);
            for (let j = 1; j <= minorTicks; j++) {
                const minorValue = tickValue + (j * minorStep);
                const minorRatio = (minorValue - min) / (max - min);
                const minorAngle = startAngle + (minorRatio * range);
                const mp1 = polarToCartesian(center, center, radius - 10, minorAngle);
                const mp2 = polarToCartesian(center, center, radius - 16, minorAngle);
                ticks.push(
                    <line
                        key={`minor-${i}-${j}`}
                        x1={mp1.x} y1={mp1.y} x2={mp2.x} y2={mp2.y}
                        stroke="#64748b" strokeWidth="1"
                    />
                );
            }
        }
    }

    // Needle
    const needleTip = polarToCartesian(center, center, radius - 25, angle);
    const needleBaseL = polarToCartesian(center, center, 5, angle - 90);
    const needleBaseR = polarToCartesian(center, center, 5, angle + 90);

    return (
        <Box sx={{ position: 'relative', width: size, height: size, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <svg width={size} height={size} style={{ overflow: 'visible' }}>
                {/* Gauge Background Ring */}
                <circle cx={center} cy={center} r={radius - 5} fill="none" stroke="#1e293b" strokeWidth="4" />

                {/* Ticks */}
                {ticks}

                {/* Needle */}
                <path
                    d={`M ${needleBaseL.x} ${needleBaseL.y} L ${needleTip.x} ${needleTip.y} L ${needleBaseR.x} ${needleBaseR.y} Z`}
                    fill={color}
                    stroke="black"
                    strokeWidth="1"
                    filter="drop-shadow(0px 2px 2px rgba(0,0,0,0.5))"
                />
                <circle cx={center} cy={center} r="6" fill="#334155" stroke="white" strokeWidth="1" />
            </svg>

            {/* Value & Unit - Centered Lower */}
            <Box sx={{ position: 'absolute', top: '60%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
                <Typography variant="h4" sx={{ color: 'white', fontWeight: 'bold', lineHeight: 1, textShadow: '0 2px 4px rgba(0,0,0,0.5)', fontSize: `${size * 0.18}px` }}>
                    {typeof value === 'number' ? value.toFixed(0) : value}
                </Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8', fontSize: `${size * 0.07}px`, display: 'block' }}>
                    {unit}
                </Typography>

                {(subValue !== undefined && subValue !== null) && (
                    <Box sx={{ mt: 0.5, borderTop: '1px solid #334155', pt: 0.3 }}>
                        <Typography variant="body2" sx={{ color: '#bef264', fontWeight: 'bold', fontSize: `${size * 0.12}px`, lineHeight: 1 }}>
                            {subValue}
                        </Typography>
                        <Typography variant="caption" sx={{ color: '#94a3b8', fontSize: `${size * 0.04}px`, whiteSpace: 'nowrap' }}>
                            {subLabel || ''}
                        </Typography>
                    </Box>
                )}
            </Box>

            {/* Label - Top Center */}
            <Typography variant="body2" sx={{ position: 'absolute', top: '28%', color: '#94a3b8', fontWeight: 'bold', fontSize: `${size * 0.05}px`, textTransform: 'uppercase', letterSpacing: 1 }}>
                {label}
            </Typography>
        </Box>
    );
};

export default AnalogGauge;
