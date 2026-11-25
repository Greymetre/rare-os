// RCH-8: the three things this app asks of the phone itself — a name for the handset, where it
// is standing, and a photo.
//
// All three follow one rule: **they never block the rep's work.** A visit with no fix is a visit
// with no fix, recorded exactly as the server treats it. A refused camera is no photo. Neither
// is a reason to refuse a call that really happened, because the handover is explicit that
// losing a real visit is the worse outcome.

import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { LOCAL_PREFIX } from '../../../packages/engines/sync-queue.mjs';
import { readDay, writeDay } from './db';

export const localId = (): string => LOCAL_PREFIX + Crypto.randomUUID();
export const clientRef = (): string => Crypto.randomUUID();

// A phone's own name for itself, so a rep with a new handset does not look like a rep who
// stopped syncing. Made once and kept with the day.
export async function deviceRef(): Promise<string> {
  const held = await readDay<string>('deviceRef');
  if (held) return held;
  const made = Crypto.randomUUID();
  await writeDay('deviceRef', made);
  return made;
}

// These three names are the server's, not ours. `reach/attendance/start`, `reach/visits/check-in`
// and `.../check-out` all read `latitude`, `longitude`, `accuracy_m`, and `body()` refuses a
// field it does not know — so a tidier `lat`/`lng` here would turn every check-in into a 400 and
// block the rep's whole morning behind it.
export type Fix = {
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
};

const NO_FIX: Fix = { latitude: null, longitude: null, accuracy_m: null };

// Where the rep is standing, if the phone will say. Ten seconds is the ceiling: beyond that a
// rep is standing in a shop waiting for a satellite, which is not what this app is for.
export async function whereAmI(): Promise<Fix> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== Location.PermissionStatus.GRANTED) return NO_FIX;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    if (!fix) return NO_FIX;
    return {
      latitude: fix.coords.latitude,
      longitude: fix.coords.longitude,
      accuracy_m: fix.coords.accuracy ?? null,
    };
  } catch {
    return NO_FIX;
  }
}

export type Photo = { uri: string; contentType: string; name: string };

// A photo, already made small. The plan says "Phone par chhota karke" — resized on the device —
// and it is right: a day of full-resolution shelf photos is tens of megabytes to push up a
// market-town connection, and nobody looks at them larger than a screen.
async function shrink(uri: string, name: string): Promise<Photo> {
  try {
    const context = ImageManipulator.ImageManipulator.manipulate(uri).resize({ width: 1280 });
    const image = await context.renderAsync();
    const out = await image.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.7 });
    return { uri: out.uri, contentType: 'image/jpeg', name };
  } catch {
    // Resizing failed. The photo itself is fine, so send what the camera gave us rather than
    // dropping it.
    return { uri, contentType: 'image/jpeg', name };
  }
}

export async function takePhoto(name: string): Promise<Photo | null> {
  try {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) return null;
    const shot = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      exif: false,
    });
    if (shot.canceled || !shot.assets?.length) return null;
    return shrink(shot.assets[0].uri, name);
  } catch {
    return null;
  }
}

export async function pickPhoto(name: string): Promise<Photo | null> {
  try {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) return null;
    const shot = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      exif: false,
    });
    if (shot.canceled || !shot.assets?.length) return null;
    return shrink(shot.assets[0].uri, name);
  } catch {
    return null;
  }
}
