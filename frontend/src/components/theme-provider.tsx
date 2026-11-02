import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";

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
const themes = [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as const;
/** The theme radios of the header menu (C11). */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  return <fieldset className="p-theme-choice"><legend>Theme</legend>{themes.map(([value, label]) => <label className="p-check" key={value}><input type="radio" name="wayfinder-theme" value={value} checked={theme === value} onChange={() => setTheme(value)} />{label}</label>)}</fieldset>;
}
