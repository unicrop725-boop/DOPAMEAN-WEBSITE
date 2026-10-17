import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** Filters live in the URL: a plain GET form, so it works without JavaScript and links can be shared. */
export function FilterBar({
  label,
  resetHref,
  children,
}: {
  label: string;
  resetHref: string;
  children: React.ReactNode;
}) {
  return (
    <form
      method="get"
      role="search"
      aria-label={label}
      className="mb-4 flex flex-wrap items-end gap-3 border border-line bg-paper p-3"
    >
      {children}
      <Button type="submit" size="sm">
        Apply
      </Button>
      <Link href={resetHref} className="admin-link self-center text-sm">
        Reset
      </Link>
    </form>
  );
}

export function FilterInput({
  name,
  label,
  defaultValue,
  type = 'search',
  placeholder,
  className,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  placeholder?: string;
  className?: string;
}) {
  const id = `f-${name}`;
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
      />
    </div>
  );
}

export function FilterSelect({
  name,
  label,
  defaultValue,
  options,
  allLabel = 'All',
}: {
  name: string;
  label: string;
  defaultValue?: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  const id = `f-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} name={name} defaultValue={defaultValue ?? ''}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
