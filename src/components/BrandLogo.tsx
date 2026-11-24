import React from 'react';

interface BrandLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  framed?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<BrandLogoProps['size']>, string> = {
  sm: 'h-9 w-auto',
  md: 'h-12 w-auto',
  lg: 'h-20 w-auto',
  xl: 'h-28 w-auto',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({ className = '', size = 'md', framed = false }) => {
  const img = (
    <img
      src="/logo.png"
      alt="شعار التشغيل الذكي – مطعم المذاق اليمني"
      referrerPolicy="no-referrer"
      className={`${SIZE_CLASSES[size]} object-contain select-none ${className}`}
    />
  );

  if (framed) {
    return (
      <div className="inline-flex items-center justify-center rounded-2xl bg-white p-2 border border-[#595859]/15">
        {img}
      </div>
    );
  }

  return img;
};
