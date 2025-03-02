declare module 'fetch-blob/file.js' {
    // This is a minimal declaration for the File export from fetch-blob.
    export class File extends Blob {
      constructor(parts: BlobPart[], filename: string, options?: FilePropertyBag);
      readonly name: string;
      readonly lastModified: number;
    }
  }
  