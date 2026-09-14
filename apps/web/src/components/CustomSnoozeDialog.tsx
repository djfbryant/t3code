import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

type SnoozeChoice = { readonly snoozedUntil: string };
type Request = { readonly resolve: (choice: SnoozeChoice | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCustomSnooze(): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(choice: SnoozeChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <CustomSnoozeDialog /> : null;
}

function CustomSnoozeDialog() {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(localSnoozeDate(initial));
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput = mode === "date" ? { mode, date, time } : { mode, amount, unit };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? "Choose a valid date and time in the future."
                  : "Enter a positive duration.",
              );
              return;
            }
            finish({ snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when snoozed threads return to your inbox.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <fieldset className="flex gap-4">
              <legend className="sr-only">Schedule type</legend>
              {(["date", "duration"] as const).map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    value={value}
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      setError(null);
                    }}
                  />
                  {value === "date" ? "Date and time" : "Duration"}
                </label>
              ))}
            </fieldset>
            {mode === "date" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${id}-date`}>
                  Date
                  <Input
                    nativeInput
                    id={`${id}-date`}
                    type="date"
                    required
                    value={date}
                    min={localSnoozeDate(new Date())}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${id}-time`}>
                  Time
                  <Input
                    nativeInput
                    id={`${id}-time`}
                    type="time"
                    required
                    value={time}
                    onChange={(event) => {
                      setTime(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${id}-amount`}>
                  Snooze for
                  <Input
                    nativeInput
                    id={`${id}-amount`}
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${id}-unit`}>
                  Unit
                  <select
                    id={`${id}-unit`}
                    className="h-8.5 rounded-md border border-input bg-background px-2 sm:h-7.5"
                    value={unit}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "minutes" || value === "hours" || value === "days")
                        setUnit(value);
                      setError(null);
                    }}
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </label>
              </div>
            )}
            <p className="text-pretty text-muted-foreground">
              {mode === "date"
                ? `Your time zone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}.`
                : "Starts when you press Snooze. One day is 24 hours."}
            </p>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
