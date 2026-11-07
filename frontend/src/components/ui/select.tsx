import type { ComponentProps, ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

// Radix reserves an empty value for its placeholder. Our forms use it for choices such as “Any place”.
const emptyValue = "__wayfinder_empty__";

type SelectProps = Omit<ComponentProps<"button">, "value" | "onChange" | "defaultValue"> & {
  value: string; onValueChange: (value: string) => void; children: ReactNode;
};

export function Select({ value, onValueChange, children, disabled, name, className, ...props }: SelectProps) {
  return <SelectPrimitive.Root value={value || emptyValue} onValueChange={next => onValueChange(next === emptyValue ? "" : next)} disabled={disabled} name={name}>
    <SelectPrimitive.Trigger {...props} name={name} value={value} className={`p-select-trigger ${className ?? ""}`}>
      <SelectPrimitive.Value />
      <SelectPrimitive.Icon asChild><ChevronDown size={15} aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className="p-control-popup p-select-popup" position="popper" sideOffset={5} collisionPadding={12}>
        <SelectPrimitive.ScrollUpButton className="p-select-scroll"><ChevronUp size={14} /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="p-select-scroll"><ChevronDown size={14} /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}

export function SelectItem({ value, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item {...props} value={value || emptyValue} className="p-select-item">
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="p-select-check"><Check size={14} aria-hidden="true" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}
