# Authenticated tool inventory and approved mapping

48 live tools; 8 have output schemas. The approved mapping is enforced by the protocol adapter and resource capabilities. Schema discovery alone does not verify live write behavior.

| MCP tool | Classification | API | Notes |
| --- | --- | --- | --- |
| create-folder | action | CanvaFolderSession.createFolder |  |
| list-folder-items | observation | CanvaFolderSession.listItems |  |
| move-item-to-folder | action | CanvaLibrarySession.moveItem / CanvaFolderSession.moveItem |  |
| search-folders | observation | CanvaLibrarySession.searchFolders |  |
| export-design | action | CanvaDesignEditor.export | Conservative: creates an export job/temporary download; upstream labels read-only. |
| get-export-formats | observation | CanvaDesignReader.getExportFormats |  |
| comment-on-design | action | CanvaDesignEditor.addComment |  |
| list-comments | observation | CanvaDesignReader.listComments / CanvaCommentSession.getInfo |  |
| list-replies | observation | CanvaCommentSession.listReplies |  |
| reply-to-comment | action | CanvaCommentSession.reply |  |
| get-design | observation | CanvaDesignReader.getInfo |  |
| get-design-pages | observation | CanvaDesignReader.listPages |  |
| get-design-content | observation | CanvaDesignReader.getText |  |
| get-presenter-notes | observation | CanvaDesignReader.getPresenterNotes |  |
| search-designs | observation | CanvaLibrarySession.searchDesigns |  |
| import-design-from-url | action | CanvaLibrarySession.importDesign |  |
| copy-design | action | CanvaDesignSession.copy |  |
| create-design-from-brand-template | action | CanvaBrandTemplateSession.createDesign |  |
| create-design-from-candidate | excluded | — | Legacy flow; newer create-design is present. Brand-specific legacy generation is deferred. |
| upload-asset-from-url | action | CanvaLibrarySession.uploadAsset |  |
| resize-design | action | CanvaDesignSession.resize |  |
| merge-designs | action | CanvaDesignEditor.changePages / CanvaLibrarySession.combineDesigns | Cross-design sources are accepted only by the library capability. |
| start-editing-transaction | action | CanvaDesignEditor.beginEdit | Opens upstream draft state; never run as an unaudited read to obtain elements. |
| perform-editing-operations | action | CanvaEditingSession.apply | Eight of ten operation variants proposed; media insert/fill updates deferred pending scoped asset transfer design. |
| commit-editing-transaction | action | CanvaEditingSession.commit |  |
| cancel-editing-transaction | action | CanvaEditingSession.cancel |  |
| get-design-thumbnail | observation | CanvaEditingSession.getPreview |  |
| search-brand-templates | observation | CanvaLibrarySession.searchBrandTemplates |  |
| get-brand-template-dataset | observation | CanvaBrandTemplateSession.getDataset |  |
| resolve-shortlink | observation | CanvaLibrarySession.openDesign / resource configurator | Resolve only Canva links, retain share tokens privately, then enforce the resulting design boundary. |
| get-assets | observation | CanvaAssetReader.getInfo |  |
| list-brand-kits | observation | CanvaLibrarySession.listBrandKits |  |
| get-design-candidates | excluded | — | Legacy generation polling. |
| generate-design | excluded | — | Legacy generation. Read-only hint is not proof of no side effects or credit use. |
| create-upload-url | excluded | — | Returning a raw upload capability would allow uploads outside the action executor; a mediated upload API is future work. |
| get-design-dataset | observation | CanvaDesignReader.getDataset |  |
| publish-brand-template | action | CanvaDesignSession.publishBrandTemplate |  |
| create-brand-template-draft | action | CanvaBrandTemplateSession.openDraft |  |
| help | excluded | — | Product support is outside the proposed resource API. |
| generate-image | action | CanvaLibrarySession.generateImage |  |
| get-generate-image-job | observation | Job<CanvaAssetSession[]>.getStatus |  |
| remove-background | action | CanvaAssetSession.removeBackground |  |
| create-design | action | CanvaLibrarySession.createDesign |  |
| get-create-design-async-job | observation | Job<CanvaDesignSession>.getStatus |  |
| separate-image-layers | action | CanvaAssetSession.separateLayers |  |
| get-separate-image-layers-job | observation | Job<CanvaDesignSession>.getStatus |  |
| get-design-thumbnails | excluded | — | Explicitly internal widget tool; public page thumbnails cover the proposed API. |
| track-event-lifecycle | excluded | — | Internal widget telemetry writes; no resource capability needed. |
