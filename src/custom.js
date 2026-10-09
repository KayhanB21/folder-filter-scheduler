export async function getFiltaQuillaMessagesByRawHeaders(uriString) {
  let parts = uriString.split("://");
  let accountId = parts[0];
  let targetPath = "/" + parts[1];
  let targetFolder = await messenger.folders.query({ accountId: accountId, path: targetPath });

/*  // Force Thunderbird to background-sync and index the unclicked folder.
  // This updates the local cache without changing your tabs or opening windows.
  if (targetFolder && targetFolder.length > 0) {
    await messenger.folders.update(targetFolder[0].id, {isFavorite: false}); // this need "accountsFolders" permission
    // Give the file indexer a quick 300ms window to parse the data streams
    await new Promise(resolve => setTimeout(resolve, 300));
  }*/

  // Explicitly pass an empty matching array using "any" mode
  // This forces the query indexer to scan the specific folder path silently.
  let page = await messenger.messages.list(targetFolder[0].id);

  let subjectsList = [];

  // Paginate through the newly unhidden message results
  while (page) {
    for (let msgSummary of page.messages) {
      // Read the raw text block directly from storage disk paths
      let rawMimeStream = await messenger.messages.getRaw(msgSummary.id);

      // Convert the File object stream into a readable text block string
      let textContent = await rawMimeStream.text();

      let subjectLine = textContent.split("\n")
        .find(line => line.toLowerCase().startsWith("subject:"));

      if (subjectLine) {
        let parsedSubject = subjectLine.replace(/^subject:\s*/i, "").trim();
        subjectsList.push(parsedSubject);
      }

      // Read the live, modified message metadata directly from the database cache.
      // This exposes the Subject prepend added by FiltaQuilla.
      let fullMessageInfo = await messenger.messages.get(msgSummary.id);

      if (fullMessageInfo && fullMessageInfo.subject) {
        subjectsList.push(fullMessageInfo.subject);
      }
    }

    // Advance to next 100 entries if a trailing list pointer exists
    if (page.id) {
        page = await messenger.messages.continueList(page.id);
    } else {
        page = null; // Cleanly break the loop when finished
    }
  }

  return subjectsList;
}
