import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900 ${className}`}>
      {children}
    </div>
  );
}

Card.Header = function CardHeader({ children, className = '' }: CardProps) {
  return (
    <div className={`flex items-center justify-between border-b border-gray-200 pb-4 dark:border-gray-800 ${className}`}>
      {children}
    </div>
  );
};

Card.Content = function CardContent({ children, className = '' }: CardProps) {
  return <div className={`pt-4 ${className}`}>{children}</div>;
};