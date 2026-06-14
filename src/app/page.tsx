'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer
} from 'recharts';
import {
  Activity,
  AlertTriangle,
  Settings
} from 'lucide-react';

interface ECGReading {
  id: number;
  value: number;
  created_at: string;
}

interface SessionReport {
  avg: number;
  min: number;
  max: number;
  status: 'Normal' | 'Weak Signal' | 'Abnormal';
  explanation: string;
  totalSamples: number;
  timestamp: string;
  dateString: string;
  error?: string;
}

export default function Home() {
  const [readings, setReadings] = useState<ECGReading[]>([]);
  const [currentValue, setCurrentValue] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  
  // Real-time flash indicator
  const [pulse, setPulse] = useState<boolean>(false);
  const pulseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Connection latency tracking
  const [secondsSinceLastUpdate, setSecondsSinceLastUpdate] = useState<number>(0);
  const lastUpdateRef = useRef<number>(Date.now());

  // Electrode warning
  const [isZeroForThreeSeconds, setIsZeroForThreeSeconds] = useState<boolean>(false);

  // 30s Session recording states
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingTimeLeft, setRecordingTimeLeft] = useState<number>(30);
  const [sessionReport, setSessionReport] = useState<SessionReport | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [sessionReadings, setSessionReadings] = useState<ECGReading[]>([]);

  const isRecordingRef = useRef<boolean>(false);
  const accumulatedReadingsRef = useRef<ECGReading[]>([]);
  const startTimeRef = useRef<Date>(new Date());

  // Simulation controls
  const [simulatorMode, setSimulatorMode] = useState<'off' | 'local' | 'supabase'>('off');
  const [simWaveform, setSimWaveform] = useState<'normal' | 'weak' | 'abnormal' | 'nosignal'>('normal');
  const simIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const simTickRef = useRef<number>(0);

  // PDF Exporting progress indicator
  const [isExportingPDF, setIsExportingPDF] = useState<boolean>(false);

  const lastFetchedIdRef = useRef<number | null>(null);

  // Common reading handler for both live DB subscription and client-side simulator
  const handleNewReading = useCallback((reading: ECGReading) => {
    if (lastFetchedIdRef.current === reading.id) return;
    lastFetchedIdRef.current = reading.id;

    setReadings((prev) => {
      if (prev.some(r => r.id === reading.id)) return prev;
      const updated = [...prev, reading];
      if (updated.length > 50) {
        return updated.slice(updated.length - 50);
      }
      return updated;
    });
    setCurrentValue(reading.value);

    // Flash pulsing dot
    setPulse(true);
    if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
    pulseTimeoutRef.current = setTimeout(() => setPulse(false), 150);

    // Reset update timer
    lastUpdateRef.current = Date.now();
    setSecondsSinceLastUpdate(0);

    // Accumulate for session report if active
    if (isRecordingRef.current) {
      accumulatedReadingsRef.current.push(reading);
    }
  }, []);

  // Fetch initial last 50 readings from database
  const fetchInitialData = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('ecg_readings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      if (data && data.length > 0) {
        const chronological = [...data].reverse();
        setReadings(chronological);
        setCurrentValue(chronological[chronological.length - 1].value);
        lastUpdateRef.current = Date.now();
        setSecondsSinceLastUpdate(0);
      }
    } catch (err) {
      console.error('Error fetching initial data:', err);
    }
  }, []);

  // Poll latest reading fallback (updates every 1s)
  const pollLatestReading = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('ecg_readings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;
      if (data && data.length > 0) {
        const latest = data[0] as ECGReading;
        if (latest.id !== lastFetchedIdRef.current) {
          handleNewReading(latest);
        }
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, [handleNewReading]);

  // Polling loop effect
  useEffect(() => {
    if (simulatorMode === 'local') return;

    pollLatestReading();
    const interval = setInterval(() => {
      pollLatestReading();
    }, 1000);

    return () => clearInterval(interval);
  }, [simulatorMode, pollLatestReading]);

  // Subscribe to real-time changes
  useEffect(() => {
    fetchInitialData();

    const channel = supabase
      .channel('ecg-live-telemetry')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ecg_readings',
        },
        (payload) => {
          // Only process Supabase inserts if we are not in local simulator mode
          if (simulatorMode !== 'local') {
            const newReading = payload.new as ECGReading;
            handleNewReading(newReading);
          }
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
      if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
    };
  }, [fetchInitialData, simulatorMode, handleNewReading]);

  // Electrode disconnection monitor (amber warning if value is 0 for >3 seconds)
  useEffect(() => {
    if (currentValue === 0) {
      const timer = setTimeout(() => {
        setIsZeroForThreeSeconds(true);
      }, 3000);
      return () => clearTimeout(timer);
    } else {
      setIsZeroForThreeSeconds(false);
    }
  }, [currentValue]);

  // Last updated counter ticking every second
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsSinceLastUpdate(Math.floor((Date.now() - lastUpdateRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Waveform generator helper
  const generateECGValue = (tick: number, mode: 'normal' | 'weak' | 'abnormal' | 'nosignal') => {
    if (mode === 'nosignal') return 0;
    if (mode === 'weak') {
      return Math.round(200 + Math.random() * 100);
    }
    if (mode === 'abnormal') {
      const phase = tick % 3;
      if (phase === 0) return Math.round(3800 + Math.random() * 200);
      if (phase === 1) return Math.round(300 + Math.random() * 150);
      return Math.round(2000 + Math.random() * 500);
    }

    // Normal ECG waveform (P-Q-R-S-T) simulated at 1Hz
    const phase = tick % 6;
    switch (phase) {
      case 0:
        return 2000 + Math.round(Math.random() * 30); // Baseline
      case 1:
        return 2180; // P wave
      case 2:
        return 1750; // Q wave
      case 3:
        return 3980; // R wave (main peak)
      case 4:
        return 550;  // S wave
      case 5:
        return 2400; // T wave
      default:
        return 2000;
    }
  };

  // Run Simulator loops
  useEffect(() => {
    if (simulatorMode === 'off') {
      if (simIntervalRef.current) clearInterval(simIntervalRef.current);
      return;
    }

    simIntervalRef.current = setInterval(async () => {
      simTickRef.current += 1;
      const val = generateECGValue(simTickRef.current, simWaveform);

      if (simulatorMode === 'local') {
        const simulatedReading: ECGReading = {
          id: Date.now(),
          value: val,
          created_at: new Date().toISOString()
        };
        handleNewReading(simulatedReading);
      } else if (simulatorMode === 'supabase') {
        try {
          await supabase
            .from('ecg_readings')
            .insert([{ value: val }]);
        } catch (err) {
          console.error("Failed to insert mock reading into Supabase:", err);
        }
      }
    }, 1000);

    return () => {
      if (simIntervalRef.current) clearInterval(simIntervalRef.current);
    };
  }, [simulatorMode, simWaveform, handleNewReading]);

  // Start 30s Recording Session
  const startRecordingSession = () => {
    setSessionReport(null);
    setSessionReadings([]);
    accumulatedReadingsRef.current = [];
    startTimeRef.current = new Date();
    isRecordingRef.current = true;
    setIsRecording(true);
    setRecordingTimeLeft(30);
  };

  // Countdown timer effect
  useEffect(() => {
    if (!isRecording) return;

    if (recordingTimeLeft <= 0) {
      finishRecordingSession();
      return;
    }

    const timer = setTimeout(() => {
      setRecordingTimeLeft((prev) => prev - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [isRecording, recordingTimeLeft]);

  // Finish session, analyze data, and open Modal
  const finishRecordingSession = async () => {
    isRecordingRef.current = false;
    setIsRecording(false);
    const endTime = new Date();

    let dbReadings: ECGReading[] = [];
    try {
      const { data, error } = await supabase
        .from('ecg_readings')
        .select('*')
        .gte('created_at', startTimeRef.current.toISOString())
        .lte('created_at', endTime.toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;
      if (data && data.length > 0) {
        dbReadings = data as ECGReading[];
      }
    } catch (err) {
      console.error("Failed to fetch session readings from Supabase:", err);
    }

    // Fallback to locally collected readings if DB returns nothing (e.g. offline or timezone mismatch)
    const finalReadings = dbReadings.length > 0 ? dbReadings : accumulatedReadingsRef.current;

    if (finalReadings.length === 0) {
      alert("No data collected during session. Ensure the simulator or ESP32 is running.");
      return;
    }

    const values = finalReadings.map(r => r.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = Math.round((sum / values.length) * 10) / 10;

    let status: 'Normal' | 'Weak Signal' | 'Abnormal' = 'Normal';
    let explanation = '';

    if (avg < 500) {
      status = 'Weak Signal';
      explanation = 'Signal strength was low. Ensure electrodes are properly placed.';
    } else if (avg > 3500) {
      status = 'Abnormal';
      explanation = 'Unusual readings detected. Consult a medical professional.';
    } else {
      status = 'Normal';
      explanation = 'Heart activity appears regular during this session.';
    }

    const dateOptions: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
    const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

    setSessionReadings(finalReadings);
    setSessionReport({
      avg,
      min,
      max,
      status,
      explanation,
      totalSamples: finalReadings.length,
      timestamp: endTime.toLocaleTimeString([], timeOptions),
      dateString: endTime.toLocaleDateString([], dateOptions)
    });
    setIsModalOpen(true);
  };

  // PDF Export logic
  const exportToPDF = async () => {
    if (!sessionReport) return;
    setIsExportingPDF(true);

    try {
      // Dynamic imports to prevent SSR compilation errors in Next.js builds
      const html2canvas = (await import('html2canvas')).default;
      const { jsPDF } = await import('jspdf');

      const template = document.getElementById('pdf-report-template');
      if (!template) {
        throw new Error('PDF template element not found');
      }

      // Convert offscreen DOM element to canvas image
      const canvas = await html2canvas(template, {
        scale: 2, // Capture at high density
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff'
      });

      const imgData = canvas.toDataURL('image/png');

      // Setup jsPDF A4 Document
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pdfWidth = pdf.internal.pageSize.getWidth(); // 210mm
      const imgWidth = pdfWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);

      const cleanDate = sessionReport.dateString.replace(/,/g, '');
      const cleanTime = sessionReport.timestamp.replace(/:/g, '-');
      pdf.save(`ecg_session_report_${cleanDate}_${cleanTime}.pdf`);
    } catch (err) {
      console.error('Failed to generate PDF:', err);
      alert('Failed to export PDF. Please check the logs.');
    } finally {
      setIsExportingPDF(false);
    }
  };

  // Badge configuration based on current value
  const getStatusBadge = (val: number | null) => {
    if (val === null) {
      return {
        label: 'Offline',
        classes: 'text-gray-500 border-gray-800 bg-gray-900/30'
      };
    }
    if (val === 0) {
      return {
        label: 'No Signal',
        classes: 'text-[#f5a623] border-[#f5a623]/20 bg-[#f5a623]/5'
      };
    }
    if (val < 500) {
      return {
        label: 'Weak Signal',
        classes: 'text-[#f5a623] border-[#f5a623]/20 bg-[#f5a623]/5'
      };
    }
    if (val > 3500) {
      return {
        label: 'Abnormal Reading',
        classes: 'text-[#e05252] border-[#e05252]/20 bg-[#e05252]/5'
      };
    }
    return {
      label: 'Normal',
      classes: 'text-[#00c896] border-[#00c896]/20 bg-[#00c896]/5'
    };
  };

  const statusBadge = getStatusBadge(currentValue);

  // Format dataset for live chart display
  const formattedReadings = readings.map(r => ({
    ...r,
    timeLabel: new Date(r.created_at).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }));

  // Format session dataset for chart display
  const sessionReadingsForChart = sessionReadings.map((r, idx) => ({
    ...r,
    index: idx + 1,
    timeLabel: new Date(r.created_at).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }));

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f0f0f0] font-sans flex flex-col selection:bg-[#00c896]/20 selection:text-[#00c896]">
      {/* Header bar */}
      <header className="h-14 border-b border-[#1e1e1e] px-6 flex items-center justify-between bg-[#0a0a0a]">
        <div className="flex items-center gap-2.5">
          <Activity className="h-4.5 w-4.5 text-[#00c896]" />
          <span className="text-sm font-semibold tracking-wider uppercase font-mono">ECG Monitor</span>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="flex items-center gap-2 px-3 py-1.5 border border-[#1e1e1e] bg-[#0a0a0a]">
            <span className={`w-1.5 h-1.5 rounded-none ${isConnected ? 'bg-[#00c896] animate-pulse' : 'bg-[#e05252]'}`} />
            <span className={isConnected ? 'text-[#00c896]' : 'text-[#e05252]'}>
              {isConnected ? 'LIVE FEED CONNECTED' : 'LIVE FEED DISCONNECTED'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Layout Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
        
        {/* Left Panel: Waveform Chart */}
        <div className="lg:col-span-8 p-6 flex flex-col gap-4 border-b lg:border-b-0 lg:border-r border-[#1e1e1e] bg-[#0a0a0a]">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold tracking-wider text-[#a0a0a0] uppercase font-mono">
                ECG Signal Waveform
              </span>
              <span className="text-[10px] text-[#555] font-mono">
                Reference Range: 0 - 4095 | Timebase: 50s | Frequency: 1 Hz
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 border border-[#1e1e1e] bg-[#0c0c0c] text-[10px] font-mono">
                <span className={`w-1.5 h-1.5 ${pulse ? 'bg-[#00c896]' : 'bg-[#00c896]/20'} transition-colors duration-75`} />
                <span className="text-[#a0a0a0]">LIVE TELEMETRY</span>
              </div>
            </div>
          </div>

          {/* Line Chart Grid Container */}
          <div className="flex-1 relative min-h-[350px] border border-[#1e1e1e] bg-[#0b0b0b] p-4 flex items-center justify-center">
            {/* Zero-signal Overlay */}
            {isZeroForThreeSeconds && (
              <div className="absolute inset-0 bg-[#0a0a0a]/95 z-10 flex flex-col items-center justify-center border border-[#f5a623]/30">
                <div className="flex items-center gap-2.5 text-[#f5a623] font-mono text-xs font-semibold tracking-widest uppercase animate-pulse">
                  <AlertTriangle className="h-4 w-4" />
                  <span>No Signal — Check Electrodes</span>
                </div>
              </div>
            )}

            {formattedReadings.length > 0 ? (
              <div className="w-full h-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={formattedReadings}
                    margin={{ top: 10, right: 10, left: -25, bottom: 5 }}
                  >
                    <CartesianGrid stroke="#151515" strokeDasharray="0" />
                    <XAxis
                      dataKey="timeLabel"
                      stroke="#444"
                      fontSize={9}
                      tickLine={false}
                      axisLine={{ stroke: '#1e1e1e' }}
                      fontFamily="monospace"
                    />
                    <YAxis
                      domain={[0, 4095]}
                      stroke="#444"
                      fontSize={9}
                      tickLine={false}
                      axisLine={{ stroke: '#1e1e1e' }}
                      ticks={[0, 1000, 2000, 3000, 4095]}
                      fontFamily="monospace"
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#00c896"
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="text-center font-mono flex flex-col items-center gap-2">
                <Activity className="h-5 w-5 text-[#333] animate-pulse" />
                <span className="text-xs text-[#555] uppercase tracking-wider">No Telemetry Stream Detected</span>
                <span className="text-[10px] text-[#444]">Use system diagnostics panel to start simulation</span>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Readouts and trigger */}
        <div className="lg:col-span-4 p-6 flex flex-col gap-6 bg-[#0a0a0a]">
          
          {/* Top Card: Live Value readout */}
          <div className="border border-[#1e1e1e] p-5 flex flex-col gap-4 bg-[#0a0a0a]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wider text-[#a0a0a0] uppercase font-mono">
                Telemetry Readout
              </span>
              <span className="text-[10px] text-[#555] font-mono">UNIT: ADC_12B</span>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-6xl font-extrabold tracking-tighter font-mono text-[#f0f0f0]">
                {currentValue !== null ? currentValue : '---'}
              </span>
              <div className="flex flex-col items-end gap-1">
                <span className={`px-2 py-0.5 text-[10px] font-mono font-semibold uppercase border ${statusBadge.classes}`}>
                  {statusBadge.label}
                </span>
                <span className="text-[9px] text-[#555] font-mono uppercase tracking-wide">
                  Updated {secondsSinceLastUpdate}s ago
                </span>
              </div>
            </div>

            {/* Micro visual gauge */}
            <div className="h-1 bg-[#1e1e1e] w-full relative">
              <div 
                className="h-full transition-all duration-300 bg-[#00c896]" 
                style={{ 
                  width: `${currentValue ? (currentValue / 4095) * 100 : 0}%`,
                  backgroundColor: currentValue ? (currentValue === 0 || currentValue < 500 ? '#f5a623' : currentValue > 3500 ? '#e05252' : '#00c896') : '#1e1e1e'
                }}
              />
            </div>
          </div>

          {/* Bottom Card: Session Trigger Panel */}
          <div className="border border-[#1e1e1e] p-5 flex flex-col gap-4 bg-[#0a0a0a] flex-1 justify-between min-h-[160px]">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between border-b border-[#1e1e1e] pb-3">
                <span className="text-xs font-semibold tracking-wider text-[#a0a0a0] uppercase font-mono">
                  Cardiovascular Session
                </span>
                <span className="text-[10px] text-[#555] font-mono">SPAN: 30s</span>
              </div>
              <p className="text-[10px] text-[#777] font-mono leading-relaxed mt-1">
                Triggering a session will capture 30 consecutive telemetry points directly from the database and generate a clinical-grade diagnostic report.
              </p>
            </div>

            {/* Recording Controls */}
            {!isRecording ? (
              <button
                onClick={startRecordingSession}
                className="w-full py-2.5 border border-[#1e1e1e] hover:border-[#00c896] bg-[#0c0c0c] hover:bg-[#00c896]/5 text-xs font-mono font-semibold tracking-widest uppercase transition-colors"
              >
                Start 30s Reading
              </button>
            ) : (
              <button
                disabled
                className="w-full py-2.5 border border-[#1e1e1e] bg-[#0f0f0f] text-[#f5a623] text-xs font-mono font-semibold tracking-widest uppercase flex items-center justify-center gap-2"
              >
                <span className="w-1.5 h-1.5 bg-[#f5a623] animate-ping" />
                Recording... {recordingTimeLeft}s remaining
              </button>
            )}
          </div>

          {/* Sub-Card: Diagnostics & Simulation */}
          <div className="border border-[#1e1e1e] p-4 flex flex-col gap-3 bg-[#0a0a0a]">
            <div className="flex items-center gap-1.5 border-b border-[#1e1e1e] pb-2 text-xs font-semibold text-[#a0a0a0] font-mono">
              <Settings className="h-3.5 w-3.5" />
              <span>CLINICAL DIAGNOSTICS</span>
            </div>

            <div className="flex flex-col gap-2">
              {/* Simulator state toggles */}
              <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
                <button
                  onClick={() => setSimulatorMode('off')}
                  className={`py-1 border transition-colors ${
                    simulatorMode === 'off' ? 'border-[#e05252] text-[#e05252] bg-[#e05252]/5' : 'border-[#1e1e1e] text-[#555] hover:text-[#a0a0a0]'
                  }`}
                >
                  SIM OFF
                </button>
                <button
                  onClick={() => setSimulatorMode('local')}
                  className={`py-1 border transition-colors ${
                    simulatorMode === 'local' ? 'border-[#00c896] text-[#00c896] bg-[#00c896]/5' : 'border-[#1e1e1e] text-[#555] hover:text-[#a0a0a0]'
                  }`}
                >
                  LOCAL SIM
                </button>
                <button
                  onClick={() => setSimulatorMode('supabase')}
                  className={`py-1 border transition-colors ${
                    simulatorMode === 'supabase' ? 'border-[#00c896] text-[#00c896] bg-[#00c896]/5' : 'border-[#1e1e1e] text-[#555] hover:text-[#a0a0a0]'
                  }`}
                  title="Inserts readings into Supabase database to test full realtime connection pipeline"
                >
                  DB WRITE SIM
                </button>
              </div>

              {/* Waveform modes */}
              {simulatorMode !== 'off' && (
                <div className="flex flex-col gap-1.5 border-t border-[#1e1e1e]/50 pt-2.5">
                  <span className="text-[8px] text-[#555] font-mono uppercase">Waveform Signal Type:</span>
                  <div className="grid grid-cols-4 gap-1 text-[8px] font-mono">
                    {(['normal', 'weak', 'abnormal', 'nosignal'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setSimWaveform(mode)}
                        className={`py-1 border uppercase transition-colors ${
                          simWaveform === mode ? 'border-[#f0f0f0] text-[#f0f0f0]' : 'border-[#1e1e1e] text-[#555] hover:text-[#a0a0a0]'
                        }`}
                      >
                        {mode === 'nosignal' ? 'No Sig' : mode}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Report Modal Box (Centered overlay) */}
      {isModalOpen && sessionReport && (
        <div className="fixed inset-0 z-50 bg-[#000000]/75 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-[#0a0a0a] border border-[#1e1e1e] p-6 flex flex-col gap-5 text-[#f0f0f0] rounded-none">
            
            {/* Modal Header */}
            <div className="flex justify-between items-start border-b border-[#1e1e1e] pb-3">
              <div className="flex flex-col">
                <span className="text-xs font-bold tracking-wider uppercase font-mono text-[#00c896]">
                  ECG Session Report
                </span>
                <span className="text-[9px] text-[#666] font-mono">
                  {sessionReport.dateString} &bull; {sessionReport.timestamp}
                </span>
              </div>
              <span className="text-[9px] text-[#555] border border-[#1e1e1e] px-1.5 py-0.5 font-mono">
                TELEMETRY EVAL
              </span>
            </div>

            {/* Modal Body */}
            <div className="flex flex-col gap-4">
              {/* Three Column Stats Row */}
              <div className="grid grid-cols-3 gap-3">
                <div className="border border-[#1e1e1e] bg-[#0c0c0c] p-3 font-mono text-center">
                  <span className="text-[8px] text-[#555] block uppercase">Average Value</span>
                  <span className="text-2xl font-bold text-[#f0f0f0]">{sessionReport.avg}</span>
                </div>
                <div className="border border-[#1e1e1e] bg-[#0c0c0c] p-3 font-mono text-center">
                  <span className="text-[8px] text-[#555] block uppercase">Minimum Value</span>
                  <span className="text-2xl font-bold text-[#f0f0f0]">{sessionReport.min}</span>
                </div>
                <div className="border border-[#1e1e1e] bg-[#0c0c0c] p-3 font-mono text-center">
                  <span className="text-[8px] text-[#555] block uppercase">Maximum Value</span>
                  <span className="text-2xl font-bold text-[#f0f0f0]">{sessionReport.max}</span>
                </div>
              </div>

              {/* Status Banner and narrative */}
              <div className="flex flex-col gap-2 border border-[#1e1e1e] bg-[#0b0b0b] p-3.5 font-mono">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#a0a0a0]">Evaluation Classification:</span>
                  <span className={`font-semibold uppercase ${
                    sessionReport.status === 'Normal' ? 'text-[#00c896]' :
                    sessionReport.status === 'Weak Signal' ? 'text-[#f5a623]' : 'text-[#e05252]'
                  }`}>
                    {sessionReport.status}
                  </span>
                </div>
                <p className="text-[10px] text-[#a0a0a0] leading-relaxed border-t border-[#1e1e1e] pt-2 mt-1">
                  {sessionReport.explanation}
                </p>
              </div>

              {/* Waveform Visualization */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[8px] text-[#555] font-mono uppercase tracking-wider">
                  Session Waveform History (30s)
                </span>
                <div className="h-[140px] border border-[#1e1e1e] bg-[#0b0b0b] p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sessionReadingsForChart} margin={{ top: 5, right: 5, left: -30, bottom: 0 }}>
                      <CartesianGrid stroke="#121212" strokeDasharray="3 3" />
                      <XAxis dataKey="index" stroke="#333" fontSize={8} tickLine={false} />
                      <YAxis domain={[0, 4095]} stroke="#333" fontSize={8} tickLine={false} />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#00c896"
                        strokeWidth={1}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Modal Footer Controls */}
            <div className="flex items-center justify-end gap-3 border-t border-[#1e1e1e] pt-4 mt-1 font-mono text-xs">
              <button
                onClick={exportToPDF}
                disabled={isExportingPDF}
                className="px-4 py-2 border border-[#1e1e1e] hover:border-[#00c896] hover:bg-[#00c896]/5 text-[#a0a0a0] hover:text-[#00c896] font-semibold transition-colors disabled:opacity-50"
              >
                {isExportingPDF ? 'Exporting...' : 'Export as PDF'}
              </button>
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 border border-[#1e1e1e] hover:border-[#e05252] hover:bg-[#e05252]/5 text-[#a0a0a0] hover:text-[#e05252] font-semibold transition-colors"
              >
                Close
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Hidden PDF Printable Template Container (Rendered off-screen) */}
      {sessionReport && (
        <div
          id="pdf-report-template"
          className="absolute left-[-9999px] top-[-9999px] w-[750px] bg-white text-black p-10 font-mono flex flex-col gap-6"
          style={{ color: '#000000', backgroundColor: '#ffffff' }}
        >
          {/* Letterhead Header */}
          <div className="flex justify-between items-end border-b-2 border-black pb-4" style={{ borderColor: '#000000' }}>
            <div>
              <h1 className="text-2xl font-bold tracking-wider uppercase">ECG Session Report</h1>
              <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide">IoT Hemodynamic Surveillance System</p>
            </div>
            <div className="text-right text-xs">
              <p className="font-bold">Date: {sessionReport.dateString}</p>
              <p>Time: {sessionReport.timestamp}</p>
            </div>
          </div>

          {/* Metadata Section */}
          <div className="grid grid-cols-2 gap-4 text-xs border-b border-gray-200 pb-4" style={{ borderColor: '#e5e7eb' }}>
            <div>
              <p><span className="text-gray-400 uppercase font-semibold text-[9px] block">Institution:</span> Dayananda Sagar College of Engineering</p>
              <p className="mt-1"><span className="text-gray-400 uppercase font-semibold text-[9px] block">Department:</span> Department of Telecommunication</p>
            </div>
            <div>
              <p><span className="text-gray-400 uppercase font-semibold text-[9px] block">Device ID:</span> ESP32-ECG-TELEMETRY</p>
              <p className="mt-1"><span className="text-gray-400 uppercase font-semibold text-[9px] block">Channel ID:</span> ecg-live-telemetry</p>
            </div>
          </div>

          {/* Metrics Summary Table */}
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-800">Session Statistics Summary</h3>
            <table className="w-full text-xs text-left border-collapse border border-gray-300" style={{ borderColor: '#d1d5db' }}>
              <thead>
                <tr className="bg-gray-100 uppercase text-gray-700 font-semibold">
                  <th className="border border-gray-300 p-2" style={{ borderColor: '#d1d5db' }}>Telemetry Parameter</th>
                  <th className="border border-gray-300 p-2 text-right" style={{ borderColor: '#d1d5db' }}>Recorded Value</th>
                  <th className="border border-gray-300 p-2 text-center" style={{ borderColor: '#d1d5db' }}>Reference Range</th>
                  <th className="border border-gray-300 p-2 text-center" style={{ borderColor: '#d1d5db' }}>Evaluation</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-gray-300 p-2" style={{ borderColor: '#d1d5db' }}>Average ECG Value</td>
                  <td className="border border-gray-300 p-2 text-right font-bold" style={{ borderColor: '#d1d5db' }}>{sessionReport.avg}</td>
                  <td className="border border-gray-300 p-2 text-center text-gray-400" style={{ borderColor: '#d1d5db' }}>500 - 3500</td>
                  <td className="border border-gray-300 p-2 text-center font-bold uppercase" style={{ 
                    borderColor: '#d1d5db',
                    color: sessionReport.status === 'Normal' ? '#00c896' : sessionReport.status === 'Weak Signal' ? '#f5a623' : '#e05252'
                  }}>
                    {sessionReport.status}
                  </td>
                </tr>
                <tr>
                  <td className="border border-gray-300 p-2" style={{ borderColor: '#d1d5db' }}>Minimum ECG Value</td>
                  <td className="border border-gray-300 p-2 text-right" style={{ borderColor: '#d1d5db' }}>{sessionReport.min}</td>
                  <td className="border border-gray-300 p-2 text-center text-gray-400" style={{ borderColor: '#d1d5db' }}>&gt; 0</td>
                  <td className="border border-gray-300 p-2 text-center text-gray-300" style={{ borderColor: '#d1d5db' }}>---</td>
                </tr>
                <tr>
                  <td className="border border-gray-300 p-2" style={{ borderColor: '#d1d5db' }}>Maximum ECG Value</td>
                  <td className="border border-gray-300 p-2 text-right" style={{ borderColor: '#d1d5db' }}>{sessionReport.max}</td>
                  <td className="border border-gray-300 p-2 text-center text-gray-400" style={{ borderColor: '#d1d5db' }}>&lt; 4095</td>
                  <td className="border border-gray-300 p-2 text-center text-gray-300" style={{ borderColor: '#d1d5db' }}>---</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Diagnosis Summary Banner */}
          <div className="border p-4 flex flex-col gap-2" style={{ 
            borderColor: sessionReport.status === 'Normal' ? '#00c896' : sessionReport.status === 'Weak Signal' ? '#f5a623' : '#e05252',
            backgroundColor: sessionReport.status === 'Normal' ? '#eefdf6' : sessionReport.status === 'Weak Signal' ? '#fffbeb' : '#fef2f2'
          }}>
            <div className="flex justify-between items-center text-xs font-bold uppercase" style={{
              color: sessionReport.status === 'Normal' ? '#007f5f' : sessionReport.status === 'Weak Signal' ? '#b45309' : '#b91c1c'
            }}>
              <span>Clinical Classification:</span>
              <span className="underline">{sessionReport.status}</span>
            </div>
            <p className="text-xs font-medium text-gray-800">{sessionReport.explanation}</p>
          </div>

          {/* Waveform Section */}
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-800">Recorded Session Waveform (30 Seconds)</h3>
            <div className="w-[670px] h-[200px] border border-gray-300 p-2 bg-gray-50" style={{ borderColor: '#d1d5db' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sessionReadingsForChart} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                  <XAxis dataKey="index" stroke="#888" fontSize={8} tickLine={false} />
                  <YAxis domain={[0, 4095]} stroke="#888" fontSize={8} tickLine={false} />
                  <Line type="monotone" dataKey="value" stroke="#00c896" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Institutional Footer */}
          <div className="mt-8 border-t border-gray-300 pt-4 text-center text-[9px] text-gray-400 uppercase tracking-widest" style={{ borderColor: '#e5e7eb' }}>
            Dayananda Sagar College of Engineering — IoT Project 2025-26
          </div>
        </div>
      )}

      {/* Footer bar */}
      <footer className="h-10 border-t border-[#1e1e1e] flex items-center justify-center text-[10px] text-[#555] bg-[#0a0a0a] font-mono uppercase tracking-widest">
        Dayananda Sagar College of Engineering — IoT Project 2025-26
      </footer>
    </div>
  );
}
