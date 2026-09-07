'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import {
  FieldLabelRow,
  FieldMessage,
  composeDescribedBy,
  shouldShowDescription,
} from '@/components/ui/field';
import Spinner from '@/components/ui/spinner';
import { CheckCircle, XCircle, Eye, EyeOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ---------------- Types ---------------- */

/**
 * The object a form library hands a field: the value, the two handlers and a ref.
 *
 * Written out here rather than imported so this stays a plain UI component with no
 * dependency on React Hook Form, but it is structurally what RHF's `field` is, so
 * `fieldProps={field}` type-checks without a cast at any of the call sites.
 */
type FieldBinding = {
  name?: string;
  value?: string | number | readonly string[];
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  ref?: React.Ref<HTMLInputElement>;
};

interface InputGroupProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  name: string;
  /** Scoped strictly to the <label>. It must never reach the input: see the note below. */
  labelClassName?: string;
  /** A form library's field object, e.g. React Hook Form's `field`. */
  fieldProps?: FieldBinding;
  error?: string;
  description?: string;
  /**
   * Keep the description visible while an error is showing. Off by default, because one
   * message under a field reads better than a stack of them; turn it on where the
   * description is what you need in order to *fix* the error, such as password rules.
   */
  showDescriptionWithError?: boolean;
  additionalDescribedBy?: string | string[];
  /**
   * A decorative glyph inside the field, on the leading edge. Passed as the component rather
   * than an element so this stays generic: the field knows nothing about which icon it is
   * drawing, and no icon is hard-coded here. It is `aria-hidden`, because the label already
   * names the field and an icon repeating that is noise to a screen reader.
   */
  leadingIcon?: LucideIcon;
  showStatus?: boolean;
  isValid?: boolean;
  /** `true`, or the words to announce while checking. Either way it draws a spinner. */
  isChecking?: boolean | string;
  showEye?: boolean;
  isPasswordVisible?: boolean;
  togglePasswordVisibility?: () => void;
  // Marks the field required: renders the visible "*" next to the label and sets
  // aria-required on the input, so the requirement is conveyed both ways.
  requiredMark?: boolean;
  /** Shorthand for `onChange={(e) => setValue(e.target.value)}`. */
  setValue?: (val: string) => void;
  type?: React.HTMLInputTypeAttribute;
}

/* ================================================= */

const InputGroup = React.forwardRef<HTMLInputElement, InputGroupProps>(function InputGroup(
  {
    label,
    labelClassName,
    name,
    fieldProps,
    error,
    description,
    showDescriptionWithError,
    additionalDescribedBy,
    leadingIcon: LeadingIcon,
    showStatus,
    isValid,
    isChecking,
    showEye,
    isPasswordVisible,
    togglePasswordVisibility,
    // Destructured so it isn't forwarded onto the DOM input; it drives the label's
    // marker and the input's aria-required below.
    requiredMark,
    className,
    setValue,
    // Destructured, not left in `rest`: it has to go through handleChange, and an
    // onChange landing on the input directly as well would fire the caller twice.
    onChange,
    type = 'text',
    id,
    value,
    defaultValue,
    onBlur,
    placeholder,
    disabled,
    readOnly,
    ...rest
  },
  ref,
) {
  const inputId = id ?? name;
  const labelId = `${inputId}-label`;
  const descId = `${inputId}-desc`;
  const errorId = `${inputId}-error`;
  const statusId = `${inputId}-status`;

  const fieldName = fieldProps?.name;
  const fieldValue = fieldProps?.value;
  const fieldOnChange = fieldProps?.onChange;
  const fieldOnBlur = fieldProps?.onBlur;
  const fieldRef = fieldProps?.ref;

  /*
   * Controlled unless the caller opted out by passing `defaultValue` and no value at all.
   *
   * Latched on the first render rather than recomputed, because deciding it per render is
   * exactly how React's controlled/uncontrolled warning happens: a value that starts
   * undefined and arrives a tick later would flip the input mid-life. Every call site in
   * the app is controlled today, so this changes nothing for them; it only makes the
   * uncontrolled form that the public prop type advertises actually work.
   */
  const uncontrolled = React.useRef(
    value === undefined && fieldValue === undefined && defaultValue !== undefined,
  ).current;
  const currentValue = uncontrolled ? undefined : (fieldValue ?? value ?? '');

  const [pwdVisibleInternal, setPwdVisibleInternal] = React.useState(false);
  const externallyControlled = typeof isPasswordVisible === 'boolean';
  const pwdVisible = externallyControlled ? !!isPasswordVisible : pwdVisibleInternal;

  const hasEye = !!showEye;
  const hasStatus = !!showStatus;

  const effectiveType = hasEye && type === 'password' ? (pwdVisible ? 'text' : 'password') : type;

  const handleChange = (evt: React.ChangeEvent<HTMLInputElement>) => {
    // A fixed, documented order rather than whichever prop happens to be set. The form
    // library goes first because it owns the value, then the caller's own onChange, then
    // setValue. setValue is skipped when the form library already handled the update, so
    // a field bound both ways is never written twice.
    fieldOnChange?.(evt);
    onChange?.(evt);
    if (!fieldOnChange) setValue?.(evt.target.value);
  };

  const handleBlur = (evt: React.FocusEvent<HTMLInputElement>) => {
    fieldOnBlur?.(evt);
    onBlur?.(evt);
  };

  const handleToggleEye = () => {
    if (externallyControlled) {
      togglePasswordVisibility?.();
    } else {
      setPwdVisibleInternal((s) => !s);
    }
  };

  /*
   * One message under the field, not a stack of them.
   *
   * The error wins, so a dense settings form does not carry helper text and an error at
   * once and grow taller as it is filled in. Swapping one line for another also keeps the
   * height roughly stable, which is the cheap version of reserving space for an error.
   * Where the description is what you need in order to correct the field, the caller asks
   * for both with showDescriptionWithError.
   */
  const showDescription = shouldShowDescription(description, error, showDescriptionWithError);

  // Deduplicated, and only ever naming elements that are actually rendered: a repeated id
  // is read twice, and one pointing at a missing element is a dangling reference.
  const describedByAttr = composeDescribedBy(
    error ? errorId : undefined,
    showDescription ? descId : undefined,
    hasStatus ? statusId : undefined,
    additionalDescribedBy,
  );

  // Room for the adornments, which sit 4px in from the border and are 32px wide each.
  const adornmentCount = (hasStatus ? 1 : 0) + (hasEye ? 1 : 0);
  const inputPaddingRight = adornmentCount === 2 ? 'pr-18' : adornmentCount === 1 ? 'pr-10' : '';
  // Its own decision, deliberately kept apart from the right-hand count above. The two edges
  // hold different things and a field can have either, both or neither.
  const inputPaddingLeft = LeadingIcon ? 'pl-10' : '';

  const hasValue = String(currentValue ?? defaultValue ?? '').length > 0;

  return (
    // The vertical rhythm is one gap on the wrapper rather than a margin on each piece:
    // 4px between the label row, the field and whatever message follows, plus 2px more
    // under the label. It was an mb-1.5 here and an mt-1 on each of the two messages,
    // which is three places to keep in step. The 6px under the label is what SelectField
    // and SearchableSelect use, and a form mixes all three in one column.
    <div className={cn('flex flex-col gap-1', className)}>
      {/* The marker sits beside the label, not inside it, so the label text stays the
          bare field name for both the accessible name and label-based queries.

          text-sm and leading-none on the marker so it matches the label it belongs to. It
          inherited the page's 16px and its default line height, which made it the taller of
          the two: `items-center` grew the row, and every required field sat 5px lower than
          its neighbours. The asterisk was also drawn a size larger than its own label. */}
      <FieldLabelRow
        id={labelId}
        htmlFor={inputId}
        required={requiredMark}
        labelClassName={labelClassName}
      >
        {label}
      </FieldLabelRow>

      <div className="relative">
        <Input
          {...rest}
          id={inputId}
          name={fieldName ?? name}
          ref={fieldRef || ref}
          type={effectiveType}
          {...(uncontrolled ? { defaultValue } : { value: currentValue })}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          aria-labelledby={labelId}
          aria-invalid={!!error || undefined}
          aria-required={requiredMark || undefined}
          aria-describedby={describedByAttr}
          // Only what this wrapper owns. Surface, border, focus, the aria-invalid border
          // and the transition all live on Input; repeating them here meant two places to
          // change and two chances to disagree. labelClassName is NOT in this list: it
          // used to be, so `labelClassName="text-gray-800"` recoloured the typed text too.
          className={cn(
            'h-11',
            type === 'number' && 'appearance-auto',
            // Read-only is a third state, not a shade of disabled. These fields hold LTI
            // URLs and one-time tokens people are meant to copy, so the value stays at full
            // contrast with a text cursor; the dimming and the not-allowed cursor mean "you
            // cannot use this at all", which is a different thing. The surface is the full
            // muted token, the same one the read-only rich-text editor and the Configured URL
            // block use: at 40% it was all but invisible on a dark card. Applied from the prop
            // rather than Tailwind's `read-only:` variant, because a disabled input matches
            // CSS :read-only too and would pick this up as well.
            readOnly && !disabled && 'bg-muted cursor-text shadow-none',
            inputPaddingLeft,
            inputPaddingRight,
          )}
        />

        {LeadingIcon ? (
          // Decorative, and it must never take a click: the whole field is the target, and an
          // icon that swallowed one would make the left edge feel dead. Centred on the field's
          // own axis with inset-y-0 rather than a translate, so it stays centred if the height
          // ever changes.
          <span className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center">
            <LeadingIcon className="size-4" aria-hidden="true" />
          </span>
        ) : null}

        {adornmentCount > 0 && (
          // One slot for both adornments instead of a branch per combination, which is what
          // kept the right-3 / right-10 / pr-10 / pr-16 offsets in sync by hand. Transparent
          // to the pointer apart from the button, so clicking beside the icons still puts the
          // caret in the field.
          <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center">
            {hasStatus && (
              <span className="flex size-8 shrink-0 items-center justify-center">
                <StatusAdornment
                  id={statusId}
                  isChecking={isChecking}
                  isValid={isValid}
                  hasValue={hasValue}
                />
              </span>
            )}

            {hasEye && (
              <button
                type="button"
                onClick={handleToggleEye}
                /*
                 * A fixed name with a pressed state, not both changing at once.
                 * Flipping the label as well meant a screen reader said "Hide password,
                 * pressed": the name describing the action to come and the state describing
                 * the one already taken, which read as a contradiction.
                 *
                 * No onKeyDown. It is a real <button>, so Enter and Space already activate
                 * it; the handler that used to be here re-fired the toggle on top of the
                 * click the browser synthesises.
                 */
                aria-label="Show password"
                aria-pressed={pwdVisible}
                // size-8 for a ~32px target with a size-4 icon: the icon still lines up at
                // the input's own 12px inset, the box just extends behind the padding.
                className="text-muted-foreground focus-visible:ring-ring/70 pointer-events-auto flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-opacity outline-none hover:opacity-80 focus-visible:ring-[3px]"
              >
                {pwdVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            )}
          </div>
        )}
      </div>

      <FieldMessage
        description={description}
        descriptionId={descId}
        error={error}
        errorId={errorId}
        showDescriptionWithError={showDescriptionWithError}
      />
    </div>
  );
});

/* ---------------- Status ---------------- */

function StatusAdornment({
  id,
  isChecking,
  isValid,
  hasValue,
}: {
  /** Referenced by the field's `aria-describedby`, so the status is read with the field. */
  id: string;
  isChecking?: boolean | string;
  isValid?: boolean;
  hasValue: boolean;
}) {
  if (isChecking) {
    const text = typeof isChecking === 'string' ? isChecking : 'Checking...';
    return (
      <>
        {/* The spinner, not the words. Setting "Checking..." inside the field made its
            width depend on the message and put text where the value was being typed.
            The message still reaches assistive tech, through the status element that
            aria-describedby already points at. */}
        <Spinner size="sm" />
        <span id={id} className="sr-only">
          {text}
        </span>
      </>
    );
  }

  // The id has to exist even with nothing to say, or `aria-describedby` points at a missing
  // element for as long as the field is empty.
  if (!hasValue || isValid === undefined) return <span id={id} className="sr-only" />;

  // Field validation is part of the destructive/error system, not the badge system: it is
  // text-destructive here rather than the badge palette's `danger`, deliberately. Pair the
  // colour/shape-only icon with a text equivalent for AT.
  return isValid ? (
    <>
      <CheckCircle className="text-status-success size-4" aria-hidden="true" />
      <span id={id} className="sr-only">
        valid
      </span>
    </>
  ) : (
    <>
      <XCircle className="text-destructive size-4" aria-hidden="true" />
      <span id={id} className="sr-only">
        invalid
      </span>
    </>
  );
}

export default InputGroup;
