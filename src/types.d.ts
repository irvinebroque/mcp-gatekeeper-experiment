/** A sequence of result pages. Call next() until null; an empty array is not the end. */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** A long-running operation. Read again no sooner than retryAfterSeconds. */
export interface Job<T> {
  getStatus(): Promise<JobStatus<T>>;
}

export type JobStatus<T> =
  | { status: "processing"; retryAfterSeconds: number }
  | { status: "completed"; result: T }
  | { status: "failed"; code: string; message: string };

/** Access to the connected user's Canva library. Individual methods may be unavailable for the account's plan. */
export interface CanvaLibrarySession {
  /** Search accessible designs. A keyword query uses relevance order. */
  searchDesigns(options?: DesignSearch): Promise<Cursor<DesignEntry>>;
  /** Open a design by its Canva ID or Canva URL. Throws if inaccessible. */
  openDesign(idOrUrl: string): Promise<CanvaDesignSession>;
  /** Open a folder by ID; "root" means the top level of the library. */
  openFolder(id: string): Promise<CanvaFolderSession>;
  /** Open an accessible library asset by ID. */
  openAsset(id: string): Promise<CanvaAssetSession>;
  /** Find reusable brand templates. Availability depends on the Canva plan. */
  searchBrandTemplates(options?: BrandTemplateSearch): Promise<Cursor<BrandTemplateEntry>>;
  /** Open a brand template by ID. Throws if inaccessible. */
  openBrandTemplate(id: string): Promise<CanvaBrandTemplateSession>;
  /** Create a design from a brief. The result may take time or fail due to credits or account restrictions. */
  createDesign(input: DesignBrief): Promise<Job<CanvaDesignSession>>;
  /** Import a publicly accessible document URL as a new design. Canva must support the source format. */
  importDesign(input: { url: string; name: string }): Promise<Job<CanvaDesignSession[]>>;
  /** Upload publicly accessible media into this library. The URL is fetched by Canva. */
  uploadAsset(input: { url: string; name: string }): Promise<Job<CanvaAssetSession>>;
  /** Generate an image and save it as an asset in this library. */
  generateImage(input: ImageBrief): Promise<Job<CanvaAssetSession>>;
  /** Build a new design from ordered pages of accessible designs in this library. Page numbers start at 1. */
  combineDesigns(input: {
    title: string;
    sources: DesignPageSource[];
  }): Promise<Job<CanvaDesignSession>>;
  /** Move an accessible design, folder, or image to another accessible folder; "root" means the library root. */
  moveItem(input: { itemId: string; destinationFolderId: string }): Promise<void>;
}

/** Access to one folder and its current descendants. Moving an item out can make it inaccessible here. */
export interface CanvaFolderSession {
  /** Browse immediate children. Returned objects remain limited to this folder tree. */
  listItems(options?: {
    types?: ("design" | "folder" | "image")[];
    sort?: FolderSort;
  }): Promise<Cursor<FolderItem>>;
  /** Open a design currently inside this folder tree. Throws if outside it or no longer accessible. */
  openDesign(id: string): Promise<CanvaDesignEditor>;
  /** Open a subfolder currently inside this folder tree. */
  openFolder(id: string): Promise<CanvaFolderSession>;
  /** Open an image currently inside this folder tree. */
  openAsset(id: string): Promise<CanvaAssetReader>;
  /** Create an immediate child folder. */
  createFolder(name: string): Promise<CanvaFolderSession>;
  /** Move an item within this folder tree. Both IDs must be current descendants, or the destination may be this folder. */
  moveItem(input: { itemId: string; destinationFolderId: string }): Promise<void>;
}

/** Read one design. All page numbers start at 1. */
export interface CanvaDesignReader {
  /** Read title, timestamps, type, and links. Display editUrl when offering to open the design in Canva. */
  getInfo(): Promise<DesignInfo>;
  /** Browse page summaries and temporary thumbnails. */
  listPages(): Promise<Cursor<DesignPage>>;
  /** Read the formats and page subsets this design can export. */
  getExportFormats(): Promise<ExportFormatAvailability[]>;
  /** Open an existing comment thread by ID. */
  openComment(threadId: string): Promise<CanvaCommentSession>;
  /** Read available autofill fields. An empty array means no fields were reported. */
  getDataset(): Promise<DatasetField[]>;
}

/** Work with one design. Editing, export, and creation operations require the corresponding access. */
export interface CanvaDesignEditor extends CanvaDesignReader {
  /** Export this design. Use a format and page subset returned by getExportFormats(). */
  export(input: ExportOptions): Promise<Job<ExportedDesign>>;
  /** Change this design's page order or remove pages. Operations run in order against the updated page sequence. */
  changePages(operations: PageOperation[]): Promise<Job<CanvaDesignEditor>>;
  /** Add a plain-text comment to this design. */
  addComment(text: string): Promise<CanvaCommentSession>;
}

/** One design with access to create derived designs and publish brand templates. */
export interface CanvaDesignSession extends CanvaDesignEditor {
  /** Copy this design, or selected pages, to a separate design. */
  copy(options?: { pages?: number[] }): Promise<Job<CanvaDesignSession>>;
  /** Create a resized version. This may require a paid plan. */
  resize(size: CanvasSize): Promise<Job<CanvaDesignSession>>;
  /** Publish this design as an organization brand template. Requires permission to publish templates. */
  publishBrandTemplate(): Promise<Job<CanvaBrandTemplateSession>>;
}

/** One comment thread on one design. */
export interface CanvaCommentSession {
  /** Read the comment's current text, author, and timestamps. */
  getInfo(): Promise<CommentInfo>;
  /** Browse replies to this comment. */
  listReplies(): Promise<Cursor<CommentInfo>>;
  /** Add a plain-text reply to this comment. */
  reply(text: string): Promise<void>;
}

/** One library image or video. */
export interface CanvaAssetReader {
  /** Read the asset's name, media kind, tags, and temporary preview. */
  getInfo(): Promise<AssetInfo>;
}

/** One library asset with access to create derived media and designs. */
export interface CanvaAssetSession extends CanvaAssetReader {
  /** Produce an image with its background removed. Throws for unsupported media. */
  removeBackground(): Promise<Job<CanvaAssetSession>>;
}

/** One reusable brand template. */
export interface CanvaBrandTemplateSession {
  /** Read available autofill field names and kinds. */
  getDataset(): Promise<DatasetField[]>;
  /** Make a separate design from this template, optionally selecting pages. */
  createDesign(options?: { pages?: number[] }): Promise<Job<CanvaDesignSession>>;
}

export interface DesignEntry {
  summary: DesignSummary;
  design: CanvaDesignSession;
}
export interface BrandTemplateEntry {
  summary: { id: string; title: string; viewUrl?: string };
  template: CanvaBrandTemplateSession;
}
export type FolderItem =
  | { type: "design"; summary: DesignSummary; design: CanvaDesignEditor }
  | { type: "folder"; summary: FolderSummary; folder: CanvaFolderSession }
  | { type: "image"; summary: AssetInfo; asset: CanvaAssetReader };

export interface DesignSummary {
  id: string;
  title: string;
  editUrl: string;
  viewUrl?: string;
  pageCount?: number;
  designTypes?: string[];
}
export interface DesignInfo extends DesignSummary {
  /** ISO 8601 timestamp, when supplied by Canva. */
  createdAt?: string;
  /** ISO 8601 timestamp, when supplied by Canva. */
  updatedAt?: string;
  thumbnail?: ImagePreview;
}
export interface FolderSummary {
  id: string;
  name: string;
}
export interface AssetInfo {
  id: string;
  name: string;
  type: "image" | "video";
  tags: string[];
  thumbnail?: ImagePreview;
}
/** Temporary preview. Retrieve a fresh preview if the URL has expired. */
export interface ImagePreview {
  url: string;
  width?: number;
  height?: number;
}
export interface DesignPage {
  id?: string;
  pageNumber: number;
  width?: number;
  height?: number;
  thumbnail?: ImagePreview;
}
export interface DatasetField {
  name: string;
  type: "text" | "image" | "chart" | "unknown";
}
export interface CommentInfo {
  id: string;
  text: string;
  author?: { id: string; displayName?: string };
  createdAt?: string;
  updatedAt?: string;
}

export interface DesignSearch {
  query?: string;
  ownership?: "any" | "owned" | "shared";
  sort?:
    | "relevance"
    | "modified_descending"
    | "modified_ascending"
    | "title_descending"
    | "title_ascending";
}
export interface BrandTemplateSearch {
  query?: string;
  ownership?: "any" | "owned" | "shared";
}
export type FolderSort =
  | "created_ascending"
  | "created_descending"
  | "modified_ascending"
  | "modified_descending"
  | "title_ascending"
  | "title_descending";
export interface DesignBrief {
  brief: string;
  /** Choose a document or presentation. */
  format: "doc" | "presentation";
  /** Optional user-supplied presentation outline. */
  outline?: { sections: { title: string; description?: string; points?: string[] }[] };
}
export interface ImageBrief {
  prompt: string;
  aspectRatio?: "1:1" | "16:9" | "9:16";
}
export interface DesignPageSource {
  designId: string;
  pages?: number[];
}
export type CanvasSize =
  { preset: "presentation" | "whiteboard" } | { width: number; height: number };
export type PageOperation =
  { type: "move"; pages: number[]; afterPage: number } | { type: "delete"; pages: number[] };

export type ExportFormat =
  "pdf" | "png" | "jpg" | "gif" | "pptx" | "mp4" | "csv" | "html_bundle" | "html_standalone";
export interface ExportFormatAvailability {
  format: ExportFormat;
  /** If absent, no particular page subset was reported. */
  pages?: number[];
}
export type ExportOptions = { pages?: number[] } & (
  | { format: "pdf"; quality?: "regular" | "pro"; paperSize?: "a4" | "a3" | "letter" | "legal" }
  | {
      format: "png";
      quality?: "regular" | "pro";
      width?: number;
      height?: number;
      lossless?: boolean;
      transparentBackground?: boolean;
      singleImage?: boolean;
    }
  | {
      format: "jpg";
      quality?: "regular" | "pro";
      width?: number;
      height?: number;
      compressionQuality?: number;
    }
  | { format: "gif"; quality?: "regular" | "pro"; width?: number; height?: number }
  | { format: "pptx"; quality?: "regular" | "pro" }
  | { format: "mp4"; quality?: "regular" | "pro"; videoQuality: string }
  | { format: "csv" }
  | { format: "html_bundle" | "html_standalone" }
);
/** Download links are temporary. Request a fresh export if they expire. */
export interface ExportedDesign {
  format: ExportFormat;
  files: { url: string }[];
}
