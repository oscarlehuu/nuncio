import { useCallback, useRef } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

/**
 * Full-screen QR camera. Owns only camera concerns: permission gating and
 * de-duplicating the rapid-fire scan callback down to a single `onScan(text)`
 * per mount. Parsing/probing/claiming live in the pairing screen.
 */
interface QrScannerProps {
  onScan: (text: string) => void;
  onCancel: () => void;
}

export function QrScanner({ onScan, onCancel }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  // The camera fires onBarcodeScanned continuously while a code is in frame; we
  // only want the first hit to drive the (async, single-use) claim.
  const handled = useRef(false);

  const handleScan = useCallback(
    (data: string) => {
      if (handled.current) return;
      handled.current = true;
      onScan(data);
    },
    [onScan],
  );

  if (!permission) {
    // Permission state still loading.
    return <View className="flex-1 bg-background" />;
  }

  if (!permission.granted) {
    const denied = !permission.canAskAgain;
    return (
      <View className="flex-1 justify-center bg-background px-8">
        <Text className="text-xl font-semibold text-foreground">Camera access needed</Text>
        <Text className="mt-2 text-muted-foreground">
          Nuncio needs the camera to scan the pairing QR code on your desktop.
        </Text>
        <Pressable
          onPress={() => (denied ? void Linking.openSettings() : void requestPermission())}
          className="mt-6 items-center rounded-lg bg-primary px-4 py-3"
        >
          <Text className="font-semibold text-primary-foreground">
            {denied ? 'Open Settings' : 'Allow camera'}
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} className="mt-3 items-center px-4 py-3">
          <Text className="text-muted-foreground">Enter address manually</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => handleScan(data)}
      />
      <View className="absolute inset-x-0 top-16 items-center px-8">
        <Text className="text-center text-lg font-medium text-white">
          Point at the QR code in Nuncio → Settings → Remote access
        </Text>
      </View>
      <Pressable
        onPress={onCancel}
        className="absolute inset-x-0 bottom-12 mx-8 items-center rounded-lg bg-white/15 px-4 py-3"
      >
        <Text className="font-semibold text-white">Cancel</Text>
      </Pressable>
    </View>
  );
}
