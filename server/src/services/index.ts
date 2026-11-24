import type { Db } from '../db/index.ts';
import JsonImportModule from '../JobModules/jsonImport.ts';
import LibraryScanModule from '../JobModules/libraryScan.ts';
import { JobManager } from './jobManager.ts';
import { PreviewService } from './previewService.ts';

export interface AppServices {
  jobManager: JobManager;
  previewService: PreviewService;
}

/** `previewsDb` is the preview cache's own database, kept separate from the core db so
 *  disposable thumbnail bytes never bloat or lock the main file. */
export function createServices(db: Db, previewsDb: Db): AppServices {
  const jobManager = new JobManager(db);
  jobManager.registerModule(new LibraryScanModule());
  jobManager.registerModule(new JsonImportModule());
  return { jobManager, previewService: new PreviewService(previewsDb) };
}
