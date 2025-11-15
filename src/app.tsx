import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectItem, SelectContent } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  Download,
  RefreshCw,
  AlertTriangle,
  Calendar,
  Users,
  Sun,
  Moon,
  Clock,
  Plus,
  Minus,
  SlidersHorizontal,
  Activity,
  Upload,
  Info,
  X as XIcon,
  Trash2,
  RotateCcw,
  UserPlus,
} from "lucide-react";
import {
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Legend,
  Line,
  XAxis,
  YAxis,
} from "recharts";

/* =====================================================================================
   CONSTANTS & TYPES
===================================================================================== */

const WEEKDAYS = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
] as const;
type Weekday = (typeof WEEKDAYS)[number];

interface DayBlock {
  active: boolean;
  startMin: number;
  endMin: number;
  breakStartMin?: number;
  breakMins?: number;
}

/** Roster keyed by agent name → weekday → block */
type Roster = Record<string, Record<Weekday, DayBlock>>;

/** Vacations keyed by agent name → array of ranges (inclusive) */
type Vacations = Record<string, Array<{ start: string; end: string }>>;

type Level = "junior" | "mid" | "senior";

interface Agent {
  name: string;
  country: string;
  remote: boolean;
  level: Level;
  fridayAllowed: boolean;
  breakPref: "none" | "60";
}

/** Montana hourly load distribution (24h) – from Montana ticket profile */
const HOURLY_LOAD_PCT_DEFAULT: number[] = [
  3.0, 1.5, 1.0, 0.8, 0.8, 0.9, 1.2, 2.0,
  3.5, 4.0, 5.0, 6.0, 6.5, 6.8, 7.0, 7.2,
  7.0, 6.5, 6.0, 5.0, 4.0, 3.0, 2.0, 1.5,
];

/** Use same average per day for Montana across all weekdays (you can tweak later) */
const MONTANA_DAILY_AVG = 650;
const DAILY_AVG_DEFAULT: Record<Weekday, number> = {
  Saturday: MONTANA_DAILY_AVG,
  Sunday: MONTANA_DAILY_AVG,
  Monday: MONTANA_DAILY_AVG,
  Tuesday: MONTANA_DAILY_AVG,
  Wednesday: MONTANA_DAILY_AVG,
  Thursday: MONTANA_DAILY_AVG,
  Friday: MONTANA_DAILY_AVG,
};

const DEFAULT_DAY: DayBlock = {
  active: true,
  startMin: 9 * 60,
  endMin: 17 * 60,
  breakStartMin: 13 * 60,
  breakMins: 60,
};

/* =====================================================================================
   CLOUD SYNC (Netlify Functions + Blobs)
===================================================================================== */

const API_BASE = "/.netlify/functions/schedule";
const WORKSPACE = "montana";
const TOKEN = (import.meta as any).env?.VITE_WFM_TOKEN as string | undefined;

function debounce<T extends (...args: any[]) => void>(fn: T, ms = 800) {
  let t: number | undefined;
  return (...args: Parameters<T>) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

/* =====================================================================================
   HELPERS
===================================================================================== */

function toHHMM(m: number) {
  const h = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${h}:${mm}`;
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function weekdayNameFromISO(iso: string): Weekday {
  const d = new Date(iso + "T00:00:00");
  const wd = d.getDay(); // 0..6 (Sun..Sat)
  const map = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
  return map[wd] as Weekday;
}
function compareISO(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function addDaysISO(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function withinRange(date: string, start: string, end: string) {
  return compareISO(start, date) <= 0 && compareISO(date, end) <= 0;
}
function halfHourLabel(k: number) {
  const h = Math.floor(k / 2);
  const m = k % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
}

/** half-hour coverage (48 buckets) given roster + agents + vacations */
function halfHourCoverage(
  roster: Roster,
  agents: Agent[],
  day: Weekday,
  dateISO: string,
  vacations: Vacations,
) {
  const cov = Array(48).fill(0);
  for (const a of agents) {
    if (isAgentOnVacation(a.name, dateISO, vacations)) continue;
    const blk = roster[a.name]?.[day];
    if (!blk || !blk.active) continue;
    for (let k = 0; k < 48; k++) {
      const hs = k * 30,
        he = (k + 1) * 30;
      const work = Math.max(0, Math.min(blk.endMin, he) - Math.max(blk.startMin, hs));
      let brk = 0;
      if ((blk.breakMins || 0) > 0 && blk.breakStartMin !== undefined) {
        const bs = blk.breakStartMin;
        const be = blk.breakStartMin + (blk.breakMins || 0);
        brk = Math.max(0, Math.min(be, he) - Math.max(bs, hs));
      }
      if (work - brk > 0) cov[k]++;
    }
  }
  return cov;
}

/** Export CSV compatible with Sharbatly tool (agent,day,start,end,breaks) */
function exportCSV(roster: Roster, agents: Agent[]) {
  const header = ["agent", "day", "active", "start", "end", "break_start", "break_minutes"];
  const rows: string[] = [];
  for (const a of agents) {
    for (const d of WEEKDAYS) {
      const blk = roster[a.name]?.[d] || DEFAULT_DAY;
      rows.push(
        [
          a.name,
          d,
          blk.active ? "1" : "0",
          toHHMM(blk.startMin),
          toHHMM(blk.endMin),
          blk.breakStartMin != null ? toHHMM(blk.breakStartMin) : "",
          String(blk.breakMins || 0),
        ].join(","),
      );
    }
  }
  return [header.join(","), ...rows].join("\n");
}

/** simple CSV parser for import */
function parseCSV(text: string) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const parts = line.split(",").map((c) => c.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = parts[i] || ""));
    return obj;
  });
  return { headers, rows };
}

/** vacations helper */
function isAgentOnVacation(agent: string, isoDate: string, vacations: Vacations) {
  const ranges = vacations[agent] ?? [];
  for (const r of ranges) {
    if (withinRange(isoDate, r.start, r.end)) return true;
  }
  return false;
}

/** merge overlapping / adjacent vacation ranges */
function mergeRanges(ranges: Array<{ start: string; end: string }>) {
  if (ranges.length <= 1) return ranges.slice().sort((a, b) => compareISO(a.start, b.start));
  const ordered = ranges.slice().sort((a, b) => compareISO(a.start, b.start));
  const out: Array<{ start: string; end: string }> = [];
  for (const r of ordered) {
    if (out.length === 0) {
      out.push({ ...r });
      continue;
    }
    const last = out[out.length - 1];
    if (compareISO(r.start, addDaysISO(last.end, 1)) <= 0) {
      if (compareISO(r.end, last.end) > 0) last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/* =====================================================================================
   ERROR BOUNDARY
===================================================================================== */

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  constructor(props: any) {
    super(props);
    this.state = {};
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: any) {
    console.error("[App crash]", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6 text-slate-50">
          <h1 className="text-xl font-bold mb-2">Something went wrong.</h1>
          <p className="text-sm text-red-400 mb-4">
            {String(this.state.error.message || this.state.error)}
          </p>
          <p className="text-xs opacity-70">Check the browser console for stack trace.</p>
        </div>
      );
    }
    return this.props.children as any;
  }
}

/* =====================================================================================
   MAIN APP
===================================================================================== */

const halfHourBuckets = 48;

const App: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roster, setRoster] = useState<Roster>({});
  const [vacations, setVacations] = useState<Vacations>({});

  const [selectedDate, setSelectedDate] = useState<string>(isoToday());
  const [selectedDay, setSelectedDay] = useState<Weekday>(weekdayNameFromISO(isoToday()));
  const [dark, setDark] = useState(false);
  const [levelFilter, setLevelFilter] = useState<Level | "all">("all");

  const [ahtMin, setAhtMin] = useState(6);
  const [occupancy, setOccupancy] = useState(0.85);
  const [serviceBuffer, setServiceBuffer] = useState(0);

  const [dailyAvg, setDailyAvg] = useState<Record<Weekday, number>>({ ...DAILY_AVG_DEFAULT });
  const [hourlyPctByDay, setHourlyPctByDay] = useState<Record<Weekday, number[]>>(() => {
    const base = [...HOURLY_LOAD_PCT_DEFAULT];
    return {
      Saturday: base,
      Sunday: base,
      Monday: base,
      Tuesday: base,
      Wednesday: base,
      Thursday: base,
      Friday: base,
    };
  });

  // cloud sync
  const isLoadingFromCloud = useRef(true);
  const saveDebounced = useRef<(p: any) => void>(() => {});
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // keep selectedDay in sync with selectedDate
  useEffect(() => {
    setSelectedDay(weekdayNameFromISO(selectedDate));
  }, [selectedDate]);

  // load from Netlify blob on first mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}?workspace=${encodeURIComponent(WORKSPACE)}`, {
          method: "GET",
          headers: { "content-type": "application/json" },
        });
        let cloud: any = {};
        try {
          cloud = await res.json();
        } catch {
          cloud = {};
        }
        if (cloud && Object.keys(cloud).length) {
          if (Array.isArray(cloud.agents)) setAgents(cloud.agents);
          if (cloud.roster) setRoster(cloud.roster);
          if (cloud.dailyAvg) setDailyAvg(cloud.dailyAvg);
          if (cloud.hourlyPctByDay) setHourlyPctByDay(cloud.hourlyPctByDay);
          if (typeof cloud.ahtMin === "number") setAhtMin(cloud.ahtMin);
          if (typeof cloud.occupancy === "number") setOccupancy(cloud.occupancy);
          if (typeof cloud.serviceBuffer === "number") setServiceBuffer(cloud.serviceBuffer);
          if (typeof cloud.selectedDate === "string") setSelectedDate(cloud.selectedDate);
          if (cloud.vacations) setVacations(cloud.vacations);
        }
      } catch (e) {
        console.warn("[cloud load] error", e);
      } finally {
        isLoadingFromCloud.current = false;
      }
    })();
  }, []);

  // prepare debounced saver
  useEffect(() => {
    saveDebounced.current = debounce(async (payload: any) => {
      try {
        setSaveStatus("saving");
        const res = await fetch(`${API_BASE}?workspace=${encodeURIComponent(WORKSPACE)}`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(TOKEN ? { "x-wfm-token": TOKEN } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(String(res.status));
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 1200);
      } catch (e) {
        console.warn("[cloud save] error", e);
        setSaveStatus("error");
      }
    }, 800);
  }, []);

  // trigger save when key state changes
  useEffect(() => {
    if (isLoadingFromCloud.current) return;
    const payload = {
      agents,
      roster,
      dailyAvg,
      hourlyPctByDay,
      ahtMin,
      occupancy,
      serviceBuffer,
      selectedDate,
      selectedDay,
      vacations,
      brand: "Montana",
      version: 1,
      savedAt: new Date().toISOString(),
    };
    saveDebounced.current(payload);
  }, [
    agents,
    roster,
    dailyAvg,
    hourlyPctByDay,
    ahtMin,
    occupancy,
    serviceBuffer,
    selectedDate,
    selectedDay,
    vacations,
  ]);

  /* ===================================================================================
     DERIVED METRICS
  =================================================================================== */

  const loadPct48 = useMemo(() => {
    const arr = hourlyPctByDay[selectedDay] || HOURLY_LOAD_PCT_DEFAULT;
    return arr.flatMap((v) => [v / 2, v / 2]); // split each hour into two half-hours
  }, [selectedDay, hourlyPctByDay]);

  const coverage48 = useMemo(
    () => halfHourCoverage(roster, agents, selectedDay, selectedDate, vacations),
    [roster, agents, selectedDay, selectedDate, vacations],
  );

  const demand48 = useMemo(() => {
    const sum = loadPct48.reduce((a, b) => a + b, 0) || 1;
    const basePerDay = dailyAvg[selectedDay] ?? MONTANA_DAILY_AVG;
    return loadPct48.map((p) => basePerDay * (p / sum));
  }, [loadPct48, selectedDay, dailyAvg]);

  const required48 = useMemo(
    () =>
      demand48.map(
        (v30) => Math.ceil((v30 * ahtMin) / Math.max(0.1, 30 * occupancy)) + serviceBuffer,
      ),
    [demand48, ahtMin, occupancy, serviceBuffer],
  );

  const chartData = useMemo(() => {
    const maxCov = Math.max(1, ...coverage48, ...required48);
    const sum = loadPct48.reduce((a, b) => a + b, 0) || 1;
    const scale = maxCov / Math.max(...loadPct48.map((v) => v / sum));
    return Array.from({ length: halfHourBuckets }, (_, k) => ({
      bucket: k,
      coverage: coverage48[k],
      required: required48[k],
      load: +(((loadPct48[k] / sum) * scale).toFixed(2)),
      label: halfHourLabel(k),
    }));
  }, [coverage48, required48, loadPct48]);

  /* ===================================================================================
     CSV IMPORT
  =================================================================================== */

  const onImport = async (file: File) => {
    try {
      const text = await file.text();
      const { headers, rows } = parseCSV(text);
      const needed = ["agent", "day", "active", "start", "end", "break_start", "break_minutes"];
      const ok = needed.every((h) => headers.includes(h));
      if (!ok) {
        alert("CSV headers must be: " + needed.join(", "));
        return;
      }

      const daySet = new Set(WEEKDAYS);
      const toMin = (hhmm: string) => {
        if (!hhmm) return undefined;
        const [hh, mm] = hhmm.split(":").map((n) => parseInt(n, 10));
        if (Number.isNaN(hh) || Number.isNaN(mm)) return undefined;
        return Math.max(0, Math.min(23, hh)) * 60 + Math.max(0, Math.min(59, mm));
      };

      const nextRoster: Roster = { ...roster };
      let nextAgents = [...agents];

      for (const r of rows) {
        const name = r["agent"];
        const day = r["day"] as Weekday;
        if (!name || !daySet.has(day)) continue;

        // ensure agent exists in list
        if (!nextAgents.find((a) => a.name === name)) {
          nextAgents.push({
            name,
            country: "SA",
            level: "junior",
            remote: true,
            fridayAllowed: true,
            breakPref: "60",
          });
        }

        const active =
          r["active"] === "1" || (r["active"] || "").toLowerCase().trim() === "true";
        const startMin = toMin(r["start"]) ?? DEFAULT_DAY.startMin;
        const endMin = toMin(r["end"]) ?? DEFAULT_DAY.endMin;
        const breakStartMin = toMin(r["break_start"]);
        const breakMins = parseInt(r["break_minutes"] || "0", 10) || 0;

        if (!nextRoster[name]) nextRoster[name] = {} as Record<Weekday, DayBlock>;
        nextRoster[name][day] = {
          active,
          startMin,
          endMin,
          breakStartMin: breakMins > 0 ? breakStartMin : undefined,
          breakMins: Math.max(0, breakMins),
        };
      }

      setAgents(nextAgents);
      setRoster(nextRoster);
    } catch (e) {
      console.warn("[import csv] failed", e);
      alert("Failed to import CSV. See console for details.");
    }
  };

  /* ===================================================================================
     AGENT MANAGEMENT
  =================================================================================== */

  const [newName, setNewName] = useState("");
  const [newCountry, setNewCountry] = useState("SA");
  const [newLevel, setNewLevel] = useState<Level>("junior");
  const [newRemote, setNewRemote] = useState(true);
  const [newFridayAllowed, setNewFridayAllowed] = useState(true);
  const [newBreakPref, setNewBreakPref] = useState<"none" | "60">("60");

  const addAgent = () => {
    const name = newName.trim();
    if (!name) return;
    if (agents.find((a) => a.name === name)) {
      alert("Agent with this name already exists.");
      return;
    }
    const agent: Agent = {
      name,
      country: newCountry,
      level: newLevel,
      remote: newRemote,
      fridayAllowed: newFridayAllowed,
      breakPref: newBreakPref,
    };
    setAgents((prev) => [...prev, agent]);

    // build default week
    setRoster((prev) => {
      const next: Roster = { ...prev };
      const week: Record<Weekday, DayBlock> = {} as any;
      for (const d of WEEKDAYS) {
        const base: DayBlock = {
          active: d === "Friday" ? newFridayAllowed : true,
          startMin: 9 * 60,
          endMin: 17 * 60,
          breakMins: newBreakPref === "60" ? 60 : 0,
          breakStartMin: newBreakPref === "60" ? 13 * 60 : undefined,
        };
        week[d] = base;
      }
      next[name] = week;
      return next;
    });

    setNewName("");
  };

  const removeAgent = (name: string) => {
    if (!confirm(`Remove agent "${name}" from Montana roster?`)) return;
    setAgents((prev) => prev.filter((a) => a.name !== name));
    setRoster((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setVacations((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  /* ===================================================================================
     RENDER
  =================================================================================== */

  const containerClasses = dark
    ? "w-full min-h-screen bg-slate-950 text-slate-50"
    : "w-full min-h-screen bg-slate-100 text-slate-900";

  return (
    <ErrorBoundary>
      <div className={containerClasses + " p-4 md:p-6"}>
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Montana CS WFM</h1>
            <p className="text-xs text-slate-400 flex items-center gap-2 mt-1">
              <Info className="w-3 h-3" />
              Half-hour view. Saudi timezone. Montana ticket profile applied to all days.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary" className="rounded-2xl px-3 py-1">
              Saudi TZ
            </Badge>
            <div className="flex items-center gap-2" title="Dark mode">
              <Sun className="w-4 h-4" />
              <Switch checked={dark} onCheckedChange={setDark} />
              <Moon className="w-4 h-4" />
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              <Input
                type="date"
                className="h-9 w-[140px]"
                value={selectedDate}
                onChange={(e) =>
                  setSelectedDate((e.target as HTMLInputElement).value || isoToday())
                }
              />
              <Button
                variant="outline"
                size="icon"
                title="Jump to today"
                onClick={() => setSelectedDate(isoToday())}
              >
                <RotateCcw className="w-4 h-4" />
              </Button>
            </div>
            <div className="text-xs px-2 py-1 rounded-full border border-slate-200/70 dark:border-slate-700">
              {saveStatus === "saving" && "💾 Saving..."}
              {saveStatus === "saved" && "✅ Saved to cloud"}
              {saveStatus === "error" && "⚠️ Save failed"}
              {saveStatus === "idle" && "☁️ Cloud idle"}
            </div>
            <div className="hidden md:flex items-center gap-2" title="Upload CSV">
              <input
                id="csvfile"
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (f) onImport(f);
                }}
              />
              <Button variant="outline" onClick={() => document.getElementById("csvfile")?.click()}>
                <Upload className="w-4 h-4 mr-2" />
                Import CSV
              </Button>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                // Auto plan simply re-seeds roster based on current agents
                setRoster((prev) => {
                  const next: Roster = { ...prev };
                  for (const a of agents) {
                    const week: Record<Weekday, DayBlock> = {} as any;
                    for (const d of WEEKDAYS) {
                      week[d] = {
                        active: d === "Friday" ? a.fridayAllowed : true,
                        startMin: 9 * 60,
                        endMin: 17 * 60,
                        breakMins: a.breakPref === "60" ? 60 : 0,
                        breakStartMin: a.breakPref === "60" ? 13 * 60 : undefined,
                      };
                    }
                    next[a.name] = week;
                  }
                  return next;
                });
              }}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Auto plan
            </Button>
            <Button
              onClick={() => {
                const csv = exportCSV(roster, agents);
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "Montana_CS_Roster.csv";
                document.body.appendChild(a);
                setTimeout(() => {
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }, 0);
              }}
            >
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Quick day picker */}
        <div className="flex flex-wrap gap-2 mb-2" aria-label="Quick day picker">
          {WEEKDAYS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === selectedDay ? "default" : "outline"}
              onClick={() => setSelectedDay(d)}
            >
              {d.slice(0, 3)}
            </Button>
          ))}
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Showing schedule for <span className="font-mono">{selectedDate}</span> ·{" "}
          <span className="font-semibold">{selectedDay}</span>
        </p>

        <Tabs defaultValue="schedule" className="space-y-4">
          <TabsList className="grid grid-cols-3 w-full md:w-auto">
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="forecast">Forecast</TabsTrigger>
            <TabsTrigger value="vacations">Add Vacations</TabsTrigger>
          </TabsList>

          {/* Schedule tab */}
          <TabsContent value="schedule">
            <div className="grid grid-cols-12 gap-4">
              {/* Left column: notes + filters + manage agents */}
              <Card className="col-span-12 md:col-span-4 shadow-sm">
                <CardContent className="p-4 space-y-4">
                  <div className="text-xs space-y-1">
                    <div className="flex items-center gap-2 text-amber-400">
                      <AlertTriangle className="w-3 h-3" />
                      Notes
                    </div>
                    <ul className="list-disc pl-4 text-slate-400">
                      <li>
                        Agents on vacation for <span className="font-mono">{selectedDate}</span> are
                        hidden.
                      </li>
                      <li>Use Export CSV to share with ops.</li>
                    </ul>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Users className="w-4 h-4" />
                      Filter by level
                    </div>
                    <Tabs value={levelFilter} onValueChange={(v) => setLevelFilter(v as any)}>
                      <TabsList className="grid grid-cols-4">
                        <TabsTrigger value="all">All</TabsTrigger>
                        <TabsTrigger value="senior">Senior</TabsTrigger>
                        <TabsTrigger value="mid">Mid</TabsTrigger>
                        <TabsTrigger value="junior">Junior</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  {/* Manage agents */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <UserPlus className="w-4 h-4" />
                      Manage agents
                    </div>
                    {agents.length === 0 ? (
                      <p className="text-xs text-slate-400">No agents yet. Add one below.</p>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                        {agents.map((a) => (
                          <div
                            key={a.name}
                            className="flex items-center justify-between rounded-xl border border-slate-200/80 px-2 py-1 text-xs dark:border-slate-700"
                          >
                            <div className="flex flex-col">
                              <span className="font-medium">{a.name}</span>
                              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                {a.level} · {a.remote ? "remote" : "on-site"} · {a.country}
                              </span>
                            </div>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => removeAgent(a.name)}
                              title="Remove agent"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add new agent */}
                    <div className="mt-2 space-y-1">
                      <Input
                        placeholder="Agent name"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="Country"
                          value={newCountry}
                          onChange={(e) => setNewCountry(e.target.value)}
                        />
                        <Select
                          value={newLevel}
                          onValueChange={(v) => setNewLevel(v as Level)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Level" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="junior">junior</SelectItem>
                            <SelectItem value="mid">mid</SelectItem>
                            <SelectItem value="senior">senior</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center justify-between text-xs mt-1">
                        <div className="flex items-center gap-2">
                          <span>Remote</span>
                          <Switch checked={newRemote} onCheckedChange={setNewRemote} />
                        </div>
                        <div className="flex items-center gap-2">
                          <span>Friday</span>
                          <Switch
                            checked={newFridayAllowed}
                            onCheckedChange={setNewFridayAllowed}
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs mt-1">
                        <span>Break</span>
                        <Select
                          value={newBreakPref}
                          onValueChange={(v) => setNewBreakPref(v as "none" | "60")}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Break" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No break</SelectItem>
                            <SelectItem value="60">60 min</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button className="mt-2 w-full" size="sm" onClick={addAgent}>
                        <Plus className="w-4 h-4 mr-2" />
                        Add agent
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Right column: chart */}
              <Card className="col-span-12 md:col-span-8 shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
                    <Clock className="w-4 h-4" />
                    Coverage vs. required (half-hour · {selectedDay})
                  </div>
                  <div className="w-full h-64">
                    <ResponsiveContainer>
                      <ComposedChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={3} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Legend
                          verticalAlign="top"
                          align="center"
                          height={28}
                          wrapperStyle={{ paddingTop: 4 }}
                        />
                        <Bar dataKey="coverage" name="Agents covering" fill="#22c55e" />
                        <Bar dataKey="required" name="Required agents" fill="#ef4444" />
                        <Line
                          type="monotone"
                          dataKey="load"
                          name="Ticket load (scaled)"
                          dot={false}
                          stroke="#7c3aed"
                          strokeWidth={2}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Agent rows */}
              <Card className="col-span-12 shadow-sm">
                <CardContent className="p-4">
                  <div className="mb-1 font-medium">
                    {selectedDay} — Agent hours & breaks (half-hour timeline)
                  </div>
                  <p className="text-xs text-slate-400 mb-3">
                    Agents on vacation on <span className="font-mono">{selectedDate}</span> are
                    hidden below.
                  </p>
                  <div className="overflow-x-auto">
                    <div
                      className="min-w-[1280px] grid gap-2 auto-rows-auto"
                      style={{
                        gridTemplateColumns:
                          "160px 80px 160px 160px 160px 150px minmax(0,1fr)",
                      }}
                    >
                      <div className="text-xs font-semibold">Agent</div>
                      <div className="text-xs font-semibold text-center">Active</div>
                      <div className="text-xs font-semibold">Start</div>
                      <div className="text-xs font-semibold">End</div>
                      <div className="text-xs font-semibold">Break start</div>
                      <div className="text-xs font-semibold">Break (min)</div>
                      <div className="text-xs font-semibold">Half-hour timeline</div>

                      {agents
                        .filter((a) => levelFilter === "all" || a.level === levelFilter)
                        .filter((a) => !isAgentOnVacation(a.name, selectedDate, vacations))
                        .map((a) => {
                          const blk = roster[a.name]?.[selectedDay] ?? DEFAULT_DAY;
                          return (
                            <React.Fragment key={a.name + selectedDay}>
                              <div className="py-2 pr-3 text-sm sticky left-0 bg-slate-50 dark:bg-slate-950 z-20 w-[160px] shrink-0">
                                <div className="font-medium truncate">{a.name}</div>
                                <div className="text-[11px] opacity-70 whitespace-nowrap truncate">
                                  {a.level} · {a.remote ? "remote" : "on-site"} · {a.country}
                                </div>
                              </div>
                              <div className="flex items-center justify-center w-[80px] shrink-0">
                                <Switch
                                  checked={blk.active}
                                  onCheckedChange={(checked) =>
                                    setRoster((p) => ({
                                      ...p,
                                      [a.name]: {
                                        ...(p[a.name] || {}),
                                        [selectedDay]: { ...blk, active: checked },
                                      },
                                    }))
                                  }
                                  title="Enable/disable this agent"
                                />
                              </div>
                              <TimeInput
                                value={blk.startMin}
                                onChange={(v) =>
                                  setRoster((p) => ({
                                    ...p,
                                    [a.name]: {
                                      ...(p[a.name] || {}),
                                      [selectedDay]: { ...blk, startMin: v },
                                    },
                                  }))
                                }
                                disabled={!blk.active}
                              />
                              <TimeInput
                                value={blk.endMin}
                                onChange={(v) =>
                                  setRoster((p) => ({
                                    ...p,
                                    [a.name]: {
                                      ...(p[a.name] || {}),
                                      [selectedDay]: { ...blk, endMin: v },
                                    },
                                  }))
                                }
                                disabled={!blk.active}
                              />
                              <TimeInput
                                value={blk.breakStartMin ?? 13 * 60}
                                onChange={(v) =>
                                  setRoster((p) => ({
                                    ...p,
                                    [a.name]: {
                                      ...(p[a.name] || {}),
                                      [selectedDay]: { ...blk, breakStartMin: v },
                                    },
                                  }))
                                }
                                disabled={!blk.active}
                              />
                              <div className="flex items-center gap-2 w-[150px] shrink-0">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  onClick={() =>
                                    setRoster((p) => ({
                                      ...p,
                                      [a.name]: {
                                        ...(p[a.name] || {}),
                                        [selectedDay]: {
                                          ...blk,
                                          breakMins: Math.max(
                                            0,
                                            (blk.breakMins || 0) - 15,
                                          ),
                                        },
                                      },
                                    }))
                                  }
                                  disabled={!blk.active}
                                >
                                  <Minus className="w-3 h-3" />
                                </Button>
                                <Input
                                  type="number"
                                  className="h-9 w-16 text-center font-mono [font-variant-numeric:tabular-nums]"
                                  value={blk.breakMins || 0}
                                  min={0}
                                  max={180}
                                  step={15}
                                  onChange={(e) =>
                                    setRoster((p) => ({
                                      ...p,
                                      [a.name]: {
                                        ...(p[a.name] || {}),
                                        [selectedDay]: {
                                          ...blk,
                                          breakMins: parseInt(
                                            (e.target as HTMLInputElement).value || "0",
                                            10,
                                          ),
                                        },
                                      },
                                    }))
                                  }
                                  disabled={!blk.active}
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  onClick={() =>
                                    setRoster((p) => ({
                                      ...p,
                                      [a.name]: {
                                        ...(p[a.name] || {}),
                                        [selectedDay]: {
                                          ...blk,
                                          breakMins: Math.min(
                                            180,
                                            (blk.breakMins || 0) + 15,
                                          ),
                                        },
                                      },
                                    }))
                                  }
                                  disabled={!blk.active}
                                >
                                  <Plus className="w-3 h-3" />
                                </Button>
                              </div>
                              <TimelineRowHalfHour block={blk} />
                            </React.Fragment>
                          );
                        })}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Heatbar */}
              <Card className="col-span-12 shadow-sm">
                <CardContent className="p-4">
                  <div className="mb-1 text-sm font-medium">
                    Half-hour coverage ({selectedDay})
                  </div>
                  <CoverageHeatbarHalfHour coverage={coverage48} />
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Forecast tab */}
          <TabsContent value="forecast">
            <div className="grid grid-cols-12 gap-4">
              <Card className="col-span-12 md:col-span-4 shadow-sm">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <SlidersHorizontal className="w-4 h-4" />
                    Forecast settings
                  </div>
                  <label className="text-xs font-medium">AHT (min)</label>
                  <Input
                    type="number"
                    value={ahtMin}
                    min={1}
                    max={60}
                    onChange={(e) =>
                      setAhtMin(parseFloat((e.target as HTMLInputElement).value || "6"))
                    }
                  />
                  <label className="text-xs font-medium">Occupancy target</label>
                  <Slider
                    value={[Math.round(occupancy * 100)]}
                    min={50}
                    max={95}
                    step={1}
                    onValueChange={([v]) => setOccupancy(v / 100)}
                  />
                  <div className="text-xs">{Math.round(occupancy * 100)}%</div>
                  <label className="text-xs font-medium">
                    Buffer (extra agents / 30-min)
                  </label>
                  <Input
                    type="number"
                    value={serviceBuffer}
                    min={0}
                    max={10}
                    onChange={(e) =>
                      setServiceBuffer(
                        parseInt((e.target as HTMLInputElement).value || "0", 10),
                      )
                    }
                  />
                  <label className="text-xs font-medium">Day</label>
                  <Select
                    value={selectedDay}
                    onValueChange={(v) => setSelectedDay(v as Weekday)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>

              <Card className="col-span-12 md:col-span-8 shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
                    <Activity className="w-4 h-4" />
                    Demand vs Required vs Coverage (half-hour · {selectedDay})
                  </div>
                  <div className="w-full h-64">
                    <ResponsiveContainer>
                      <ComposedChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={3} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Legend
                          verticalAlign="top"
                          align="center"
                          height={28}
                          wrapperStyle={{ paddingTop: 4 }}
                        />
                        <Bar dataKey="required" name="Required" fill="#ef4444" />
                        <Bar dataKey="coverage" name="Coverage" fill="#22c55e" />
                        <Line
                          type="monotone"
                          dataKey="load"
                          name="Load (scaled)"
                          dot={false}
                          stroke="#7c3aed"
                          strokeWidth={2}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Vacations tab */}
          <TabsContent value="vacations">
            <VacationsManager vacations={vacations} setVacations={setVacations} agents={agents} />
          </TabsContent>
        </Tabs>
      </div>
    </ErrorBoundary>
  );
};

/* =====================================================================================
   SUB-COMPONENTS
===================================================================================== */

function TimeInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const hh = Math.floor(value / 60);
  const mm = value % 60;
  return (
    <div className="flex items-center gap-1 shrink-0">
      <Input
        type="number"
        inputMode="numeric"
        pattern="[0-9]*"
        className="h-9 w-16 text-center font-mono [font-variant-numeric:tabular-nums]"
        min={0}
        max={23}
        value={hh}
        disabled={!!disabled}
        onChange={(e) => {
          const v = parseInt((e.target as HTMLInputElement).value || "0", 10);
          onChange(clamp(v, 0, 23) * 60 + mm);
        }}
      />
      <span className="text-xs px-1 opacity-70">:</span>
      <Input
        type="number"
        inputMode="numeric"
        pattern="[0-9]*"
        className="h-9 w-16 text-center font-mono [font-variant-numeric:tabular-nums]"
        min={0}
        max={59}
        value={mm}
        disabled={!!disabled}
        onChange={(e) => {
          const v = parseInt((e.target as HTMLInputElement).value || "0", 10);
          onChange(hh * 60 + clamp(v, 0, 59));
        }}
      />
    </div>
  );
}

function TimelineRowHalfHour({ block }: { block: DayBlock }) {
  const seg: { k: number; type: "work" | "break" | "off" }[] = [];
  for (let k = 0; k < halfHourBuckets; k++) {
    const hs = k * 30,
      he = (k + 1) * 30;
    const work = Math.max(0, Math.min(block.endMin, he) - Math.max(block.startMin, hs));
    let brk = 0;
    if ((block.breakMins || 0) > 0 && block.breakStartMin !== undefined) {
      const bs = block.breakStartMin;
      const be = block.breakStartMin + (block.breakMins || 0);
      brk = Math.max(0, Math.min(be, he) - Math.max(bs, hs));
    }
    const net = work - brk;
    seg.push({ k, type: net > 0 ? "work" : brk > 0 ? "break" : "off" });
  }
  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: "repeat(48, minmax(0,1fr))", gap: "2px" }}
    >
      {seg.map((s) => (
        <div
          key={s.k}
          className={`h-7 rounded-sm ${
            s.type === "work"
              ? "bg-emerald-300"
              : s.type === "break"
              ? "bg-amber-300"
              : "bg-slate-200"
          }`}
          title={halfHourLabel(s.k)}
        />
      ))}
    </div>
  );
}

function CoverageHeatbarHalfHour({ coverage }: { coverage: number[] }) {
  const max = Math.max(1, ...coverage);
  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: "repeat(48, minmax(0,1fr))", gap: "4px" }}
    >
      {coverage.map((c, k) => (
        <div key={k} className="flex flex-col items-center">
          <div
            className="w-full h-10 rounded-sm bg-violet-400"
            style={{ opacity: 0.2 + (0.8 * c) / max }}
          />
          <div className="mt-1 text-[10px] text-slate-400">
            {k % 2 === 0 ? `${String(k / 2).padStart(2, "0")}:00` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

/* Vacations manager */

function VacationsManager({
  vacations,
  setVacations,
  agents,
}: {
  vacations: Vacations;
  setVacations: React.Dispatch<React.SetStateAction<Vacations>>;
  agents: Agent[];
}) {
  const [startDate, setStartDate] = useState<string>(isoToday());
  const [endDate, setEndDate] = useState<string>(isoToday());
  const [agentName, setAgentName] = useState<string>(agents[0]?.name ?? "");
  const [viewDate, setViewDate] = useState<string>(isoToday());

  const agentsForViewDate = useMemo(
    () =>
      agents
        .map((a) => a.name)
        .filter((name) => isAgentOnVacation(name, viewDate, vacations))
        .sort(),
    [viewDate, vacations, agents],
  );

  const addVacationRange = () => {
    if (!agentName || !startDate || !endDate) return;
    if (compareISO(startDate, endDate) > 0) {
      alert("End date must be on or after start date.");
      return;
    }
    setVacations((prev) => {
      const prevList = prev[agentName] ?? [];
      const merged = mergeRanges([...prevList, { start: startDate, end: endDate }]);
      return { ...prev, [agentName]: merged };
    });
  };

  const removeRange = (name: string, idx: number) => {
    setVacations((prev) => {
      const list = (prev[name] ?? []).slice();
      list.splice(idx, 1);
      const out = { ...prev };
      if (list.length === 0) delete out[name];
      else out[name] = list;
      return out;
    });
  };

  const clearAgent = (name: string) => {
    setVacations((prev) => {
      const out = { ...prev };
      delete out[name];
      return out;
    });
  };

  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 md:col-span-5 shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="text-sm font-medium flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Add a vacation range
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">Start date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) =>
                  setStartDate((e.target as HTMLInputElement).value || isoToday())
                }
              />
            </div>
            <div>
              <label className="text-xs font-medium">End date</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) =>
                  setEndDate((e.target as HTMLInputElement).value || isoToday())
                }
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium">Agent</label>
              <Select value={agentName} onValueChange={setAgentName}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem value={a.name} key={a.name}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={addVacationRange}>
              <Plus className="w-4 h-4 mr-2" />
              Add vacation range
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            Agents on vacation won’t appear on the Schedule for any date within the range
            (inclusive).
          </p>
        </CardContent>
      </Card>

      <Card className="col-span-12 md:col-span-7 shadow-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Who’s on vacation for date
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={viewDate}
                onChange={(e) =>
                  setViewDate((e.target as HTMLInputElement).value || isoToday())
                }
              />
            </div>
          </div>

          {agentsForViewDate.length === 0 ? (
            <p className="text-sm text-slate-400">
              No one is on vacation on this date.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2 mb-3">
              {agentsForViewDate.map((who) => (
                <Badge key={who} variant="secondary">
                  {who}
                </Badge>
              ))}
            </div>
          )}

          <div className="mt-6">
            <div className="text-sm font-medium mb-2">
              All vacation ranges per agent
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400">
                    <th className="py-2 pr-4">Agent</th>
                    <th className="py-2 pr-4">Ranges</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(vacations)
                    .sort()
                    .map((name) => (
                      <tr key={name} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="py-2 pr-4 font-medium">{name}</td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-2">
                            {(vacations[name] ?? []).map((r, idx) => (
                              <span
                                key={name + idx}
                                className="inline-flex items-center gap-2 px-2 py-1 rounded-full border border-slate-200 dark:border-slate-700"
                              >
                                <span className="font-mono text-xs">{r.start}</span>
                                <span className="opacity-60 text-xs">→</span>
                                <span className="font-mono text-xs">{r.end}</span>
                                <button
                                  className="rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 p-1"
                                  onClick={() => removeRange(name, idx)}
                                  title="Remove this range"
                                >
                                  <XIcon className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                            {(vacations[name] ?? []).length === 0 && (
                              <span className="text-slate-400 text-xs">No ranges</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-4">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => clearAgent(name)}
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Clear all
                          </Button>
                        </td>
                      </tr>
                    ))}
                  {Object.keys(vacations).length === 0 && (
                    <tr>
                      <td className="py-3 text-slate-400 text-sm" colSpan={3}>
                        No vacations added yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
