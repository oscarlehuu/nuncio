import Svg, { Path } from 'react-native-svg';

/**
 * Branded engine glyphs for the mobile app — react-native-svg ports of the web
 * `provider-icon.tsx` paths so both surfaces show the same logos instead of a
 * bare text label. `color` maps to the web's `fill="currentColor"`.
 */
export type Brand = 'claude' | 'codex' | 'cursor' | 'pi' | 'gemini' | 'generic';

interface IconProps {
  size?: number;
  color?: string;
}

export function ClaudeIcon({ size = 16, color = '#eff0f1' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
      />
    </Svg>
  );
}

export function CodexIcon({ size = 16, color = '#eff0f1' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color}
        fillRule="evenodd"
        d="M9.37088 2.18576C11.1759 1.70239 13.0087 2.19059 14.3229 3.32227C16.0284 2.99798 17.8626 3.49276 19.1849 4.81496C20.5066 6.13684 21 7.96945 20.6766 9.67409C21.8096 10.9886 22.2977 12.823 21.8141 14.629C21.3301 16.4355 19.9888 17.7788 18.35 18.3506C17.7783 19.9889 16.4362 21.3295 14.6302 21.8138C12.8243 22.2976 10.9899 21.8091 9.67535 20.6763C7.97048 21.0002 6.13741 20.5067 4.81526 19.1846C3.49332 17.8624 2.99758 16.0289 3.32161 14.3235C2.18976 13.0088 1.70243 11.1746 2.18606 9.36962C2.67009 7.56414 4.00987 6.21916 5.64825 5.647C6.22058 4.009 7.56548 2.66963 9.37088 2.18576ZM12.9805 13.4704C12.4393 13.4707 12.0002 13.9097 12.0001 14.4509C12.0001 14.9922 12.4392 15.4311 12.9805 15.4313H15.9219C16.4633 15.4313 16.9023 14.9924 16.9023 14.4509C16.9022 13.9095 16.4633 13.4704 15.9219 13.4704H12.9805ZM9.40918 9.04408C9.13045 8.58016 8.52809 8.42952 8.06394 8.70801C7.60003 8.98663 7.44965 9.5891 7.72787 10.0533L8.89502 11.9998L7.72787 13.9463C7.44943 14.4104 7.60008 15.0128 8.06394 15.2915C8.52819 15.5701 9.13053 15.4196 9.40918 14.9555L10.8798 12.5044C11.0661 12.1939 11.0661 11.8057 10.8798 11.4952L9.40918 9.04408Z"
      />
    </Svg>
  );
}

export function CursorIcon({ size = 16, color = '#eff0f1' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 466.73 532.09">
      <Path
        fill={color}
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
      />
    </Svg>
  );
}

export function PiIcon({ size = 16, color = '#eff0f1' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800">
      <Path
        fill={color}
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29V165.29ZM282.65 282.65V400H400V282.65H282.65Z"
      />
      <Path fill={color} d="M517.36 400H634.72V634.72H517.36V400Z" />
    </Svg>
  );
}

/** Four-point spark — stands in for Gemini / Google models (no dedicated mark). */
export function SparkIcon({ size = 16, color = '#eff0f1' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path fill={color} d="M12 1.5l2.35 7.15L21.5 11l-7.15 2.35L12 20.5l-2.35-7.15L2.5 11l7.15-2.35L12 1.5z" />
    </Svg>
  );
}

export function brandForModel(model: {
  providerId: string;
  groupId?: string;
  id: string;
  name: string;
}): Brand {
  const hay = `${model.groupId ?? ''} ${model.id} ${model.name}`.toLowerCase();
  if (hay.includes('cursor') || hay.includes('composer')) return 'cursor';
  if (hay.includes('codex') || hay.includes('gpt') || hay.includes('openai')) return 'codex';
  if (hay.includes('claude') || hay.includes('anthropic')) return 'claude';
  if (hay.includes('gemini') || hay.includes('google')) return 'gemini';
  if (model.providerId === 'pi') return 'pi';
  return 'generic';
}

export function ProviderIcon({ brand, size = 16, color = '#eff0f1' }: { brand: Brand } & IconProps) {
  switch (brand) {
    case 'claude':
      return <ClaudeIcon size={size} color={color} />;
    case 'codex':
      return <CodexIcon size={size} color={color} />;
    case 'cursor':
      return <CursorIcon size={size} color={color} />;
    case 'gemini':
      return <SparkIcon size={size} color={color} />;
    case 'pi':
    case 'generic':
    default:
      return <PiIcon size={size} color={color} />;
  }
}
