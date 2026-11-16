import { memo } from 'react';
import type { ComponentType, SVGProps } from 'react';
import * as Flags from 'country-flag-icons/react/3x2';
import { parseServerName } from '../utils/countryFlag';

const flagComponents = Flags as unknown as Record<string, ComponentType<SVGProps<SVGSVGElement>> | undefined>;

interface ServerNameProps {
  name: string;
  className?: string;
}

/** Server name with the leading flag emoji replaced by an SVG flag that renders on Windows. */
function ServerName({ name, className }: ServerNameProps) {
  const { code, text } = parseServerName(name);
  const Flag = code ? flagComponents[code] : undefined;
  if (!code || !Flag) return <span className={className}>{name}</span>;
  return (
    <span className={className}>
      <Flag className="country-flag" aria-label={code} role="img" />
      <span className="country-flag-text">{text || code}</span>
    </span>
  );
}

export default memo(ServerName);
