/**
 * Helper to append timestamp to a filename.
 * Example: "file_new.csv" → "file_new_08-12-2025_08-07-50.csv"
 * Format: name_DD-MM-YYYY_HH-MM-SS
 */
export function appendTimestampToFilename(filename: string): string {
  const now = new Date();
  
  // Format: DD-MM-YYYY_HH-MM-SS (consistent separators, clear structure)
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  const timestamp = `${day}-${month}-${year}_${hours}-${minutes}-${seconds}`;
  
  // Split filename and extension
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) {
    // No extension
    return `${filename}_${timestamp}`;
  }
  
  const nameWithoutExt = filename.substring(0, lastDotIndex);
  const ext = filename.substring(lastDotIndex);
  
  return `${nameWithoutExt}_${timestamp}${ext}`;
}
