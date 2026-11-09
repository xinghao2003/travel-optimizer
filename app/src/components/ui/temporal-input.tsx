import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, Clock } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { acceptsTemporalText, calendarDateValue, parseCalendarDate, temporalError, type TemporalType } from "../../lib/dateInput";
import { Select, SelectItem } from "./select";

type TemporalInputProps = Omit<ComponentProps<"input">, "type" | "value" | "onChange" | "min"> & {
  type: TemporalType; value: string; min?: string; onValueChange: (value: string) => void;
};
const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

/** The value remains a local ISO date/time, matching the API's existing wall-clock semantics. */
export function TemporalInput({ type, value, onValueChange, min, id: suppliedId, disabled, "aria-describedby": describedBy, "aria-invalid": invalid, ...props }: TemporalInputProps) {
  const generatedId = useId(), id = suppliedId ?? generatedId;
  const [text, setText] = useState(value.replace("T", " "));
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setText(value.replace("T", " ")); setError(""); } }, [value]);
  // A complete popup edit may still be before `min`. Keep it available while the user adjusts its time.
  const preview = text && !temporalError(text, type) ? text.replace(" ", "T") : value;
  const selected = type === "time" ? undefined : parseCalendarDate(preview.slice(0, 10));
  const earliest = type === "time" ? undefined : parseCalendarDate(min?.slice(0, 10) ?? "");
  const currentTime = (type === "time" ? preview : preview.split("T")[1]) || "00:00";
  const [hour, minute] = currentTime.split(":");

  function commit(next: string) {
    const problem = temporalError(next, type, min);
    setText(next.replace("T", " "));
    setError(problem);
    if (!problem) onValueChange(next);
  }
  function chooseDate(date: Date) {
    commit(calendarDateValue(date) + (type === "datetime-local" ? `T${currentTime}` : ""));
    if (type === "date") setOpen(false);
  }
  function chooseTime(nextHour: string, nextMinute: string) {
    const time = `${nextHour}:${nextMinute}`;
    const date = selected ?? earliest ?? new Date();
    commit(type === "time" ? time : `${calendarDateValue(date)}T${time}`);
  }
  const format = type === "date" ? "YYYY-MM-DD" : type === "time" ? "HH:mm" : "YYYY-MM-DD HH:mm";
  return <div className="p-temporal">
    <Popover.Root open={open} onOpenChange={next => {
      if (!next && error) { setText(value.replace("T", " ")); setError(""); }
      setOpen(next);
    }}>
      <Popover.Anchor asChild>
        <div className="p-temporal-control">
          <input {...props} id={id} type="text" value={text} disabled={disabled} placeholder={format} maxLength={format.length}
            aria-invalid={error ? true : invalid} aria-describedby={[describedBy, error && `${id}-input-error`].filter(Boolean).join(" ") || undefined}
            onFocus={event => { focused.current = true; props.onFocus?.(event); }}
            onChange={event => {
              const raw = event.target.value;
              if (acceptsTemporalText(raw, type)) commit(raw.replace(" ", "T"));
            }}
            onBlur={event => {
              focused.current = false;
              // Like NumberField, incomplete edits restore the last committed value on leaving the input.
              if (error) { setText(value.replace("T", " ")); setError(""); }
              props.onBlur?.(event);
            }} />
          <Popover.Trigger asChild>
            <button type="button" className="p-temporal-toggle" disabled={disabled} aria-label={type === "time" ? "Choose time" : "Open calendar"}>
              {type === "time" ? <Clock size={16} aria-hidden="true" /> : <CalendarDays size={16} aria-hidden="true" />}
            </button>
          </Popover.Trigger>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content className="p-control-popup p-calendar-popup" align="start" sideOffset={5} collisionPadding={12}
          aria-label={type === "time" ? "Choose time" : "Choose date"}>
          {type !== "time" && <DayPicker mode="single" required autoFocus selected={selected} defaultMonth={selected ?? earliest ?? new Date()}
            startMonth={parseCalendarDate("0001-01-01")} endMonth={parseCalendarDate("9999-12-31")}
            disabled={earliest ? { before: earliest } : undefined} onSelect={chooseDate} />}
          {type !== "date" && <div className="p-time-picker">
            <label><span>Hour</span><Select aria-label="Hour" value={hour} onValueChange={next => chooseTime(next, minute)}>{hours.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</Select></label>
            <span aria-hidden="true">:</span>
            <label><span>Minute</span><Select aria-label="Minute" value={minute} onValueChange={next => chooseTime(hour, next)}>{minutes.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</Select></label>
          </div>}
          <div className="p-calendar-actions">
            {type !== "time" && <button type="button" disabled={!!earliest && calendarDateValue(new Date()) < calendarDateValue(earliest)} onClick={() => chooseDate(new Date())}>Today</button>}
            <button type="button" onClick={() => { commit(""); setOpen(false); }}>Clear</button>
            <Popover.Close asChild><button type="button">Done</button></Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {error && <span id={`${id}-input-error`} className="p-field-error" aria-live="polite">{error}</span>}
  </div>;
}
