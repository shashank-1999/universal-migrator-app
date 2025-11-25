import React from 'react';

type SelectOption = {
  value: string;
  label: string;
};

type SelectOptionGroup = {
  label: string;
  options: SelectOption[];
};

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: Array<SelectOption | SelectOptionGroup>;
}

export function Select({ label, error, options, className = '', ...props }: SelectProps) {
  return (
    <div className="space-y-2">
      {label && (
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {label}
        </label>
      )}
      <select
        className={`
          flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm 
          placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 
          focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 
          dark:border-gray-700 dark:text-gray-50 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900
          ${error ? 'border-red-500 focus:ring-red-400' : ''}
          ${className}
        `}
        {...props}
      >
        {options.map((option) => (
          'options' in option ? (
            <optgroup key={option.label} label={option.label}>
              {option.options.map((subOption) => (
                <option key={subOption.value} value={subOption.value}>
                  {subOption.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          )
        ))}
      </select>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}