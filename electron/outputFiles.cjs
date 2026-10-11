// Moving finished files into the user's output folder.
//
// Extractions work in a private folder under %TEMP%\WaveMint; only the
// finished, tagged MP3 is moved into the output folder, so nothing
// half-finished ever appears there. That matters for folders other apps
// watch: iTunes' "Automatically Add to iTunes" folder grabs (or rejects)
// files the moment they appear.

const fs = require("fs");
const path = require("path");

// Errors where a rename can't work but a copy can (another drive, or a
// destination that briefly refuses renames).
const COPY_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "EACCES", "EBUSY"]);

/**
 * Same drive: an atomic rename. Another drive: copy (never overwriting an
 * existing file), then remove the source.
 */
function moveIntoOutputFolder(sourcePath, destinationPath, { fsImpl = fs } = {}) {
  try {
    fsImpl.renameSync(sourcePath, destinationPath);
    return "renamed";
  } catch (error) {
    if (!COPY_FALLBACK_CODES.has(error.code)) throw error;
  }

  fsImpl.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  try {
    fsImpl.unlinkSync(sourcePath);
  } catch {
    // The private work folder is removed afterwards anyway.
  }
  return "copied";
}

/** iTunes and Apple Music import anything placed in these folders. */
function isAutoImportFolder(folder) {
  return /^Automatically Add to (?:iTunes|Music)$/i.test(
    path.basename(path.resolve(String(folder || ""))),
  );
}

module.exports = { isAutoImportFolder, moveIntoOutputFolder };
