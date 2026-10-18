import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "light" | "dark" | "system";
const ThemeContext = createContext<{ theme: Theme; resolved: "light" | "dark"; setTheme: (theme: Theme) => void }>({ theme: "system", resolved: "light", setTheme: () => {} });
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState<Theme>(() => { try { const t = localStorage.getItem("wayfinder:theme"); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; } });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const resolved = theme === "system" ? systemDark ? "dark" : "light" : theme;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#09090b" : "#fafafa");
  }, [resolved]);
  const setTheme = (value: Theme) => { setPreference(value); try { localStorage.setItem("wayfinder:theme", value); } catch { /* Theme remains available without storage. */ } };
  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <div className="p-theme-toggle" role="group" aria-label="Appearance">{([{ value: "light", icon: Sun, label: "Light" }, { value: "dark", icon: Moon, label: "Dark" }, { value: "system", icon: Monitor, label: "System" }] as const).map(({ value, icon: Icon, label }) => <button key={value} type="button" title={`${label} theme`} aria-label={`${label} theme`} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon size={15} /></button>)}</div>;
}
