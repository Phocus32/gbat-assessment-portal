"use strict";

const express = require("express");
const { requireAnyRole } = require("../security");
const { asyncHandler, logActivity } = require("../utils");
const {
  idSchema,
  materialUploadUrlSchema,
  materialChunkSchema,
  materialCreateSchema,
  materialUpdateSchema,
  materialListSchema
} = require("../validation");
const {
  createUploadForm,
  hasUsableBucket,
  resolveBucketName,
  resolveFileType,
  storagePathFor,
  fileExists
} = require("../storage");
const { saveChunk, readBlob } = require("../material-blobs");
const { getDocById } = require("../fdb");
const config = require("../config");
const {
  assertManageableScope,
  visibleToUser,
  allowedClassIds,
  classIdsOf,
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  trackMaterialView
} = require("../materials");
const {
  createUploadSession,
  getUploadSession,
  assertSessionOwner,
  assertSessionScope,
  assertSessionActive,
  setUploadStatus,
  expectedChunkCount,
  sameIds
} = require("../upload-sessions");

const router = express.Router();
const manage = requireAnyRole("admin", "teacher");

function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Available to every authenticated role. Students receive only their class.
router.get("/", asyncHandler(async (req, res) => {
  const filters = materialListSchema.parse(req.query);
  return res.json(await listMaterials(req.user, filters));
}));

router.post("/upload-url", manage, asyncHandler(async (req, res) => {
  const input = materialUploadUrlSchema.parse(req.body);
  await assertManageableScope(req.user, input.classIds, input.subjectId);
  const fileType = resolveFileType(input.fileName, input.contentType);
  const hasBucket = await hasUsableBucket();
  const backend = hasBucket ? "storage" : "firestore";

  if (backend === "firestore" && input.sizeBytes > config.materialFirestoreMaxBytes) {
    throw problem(413, "This project has no Cloud Storage bucket, so files larger than 10 MB cannot be uploaded.");
  }

  const storagePath = storagePathFor(input.fileName);
  const chunkSize = backend === "firestore" ? config.materialChunkBase64Bytes : null;
  const session = await createUploadSession(req.user, input, {
    backend,
    storagePath,
    fileName: input.fileName,
    contentType: input.contentType,
    fileType,
    sizeBytes: input.sizeBytes,
    chunkSize,
    chunkCount: chunkSize ? Math.max(1, Math.ceil(input.sizeBytes / chunkSize)) : null,
    classIds: input.classIds,
    subjectId: input.subjectId || null
  });

  if (backend === "firestore") {
    return res.json({
      mode: "firestore",
      uploadId: session.id,
      uploadUrl: "/api/materials/upload-chunks",
      uploadFields: {},
      storagePath,
      fileType,
      bucket: "Firestore",
      chunkSize,
      subjectId: session.subject_id,
      classIds: session.class_ids
    });
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const redirect = `${origin}/upload-complete.html?path=${encodeURIComponent(storagePath)}&uploadId=${encodeURIComponent(session.id)}`;
  const form = await createUploadForm({
    storagePath,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    successActionRedirect: redirect
  });
  return res.json({
    mode: "storage",
    uploadId: session.id,
    uploadUrl: form.url,
    uploadFields: form.fields,
    storagePath,
    fileType,
    bucket: await resolveBucketName()
  });
}));

router.post("/upload-chunks", manage, asyncHandler(async (req, res) => {
  const input = materialChunkSchema.parse(req.body);
  const session = await getUploadSession(input.uploadId);
  assertSessionOwner(session, req.user);
  assertSessionActive(session);
  if (session.backend !== "firestore") {
    throw problem(400, "This upload does not use chunk storage.");
  }
  await assertManageableScope(req.user, session.class_ids, session.subject_id);

  const result = await saveChunk({ session, index: input.index, data: input.data });
  if (result.complete && session.status !== "uploaded") {
    await setUploadStatus(session.id, "uploaded");
  }
  return res.json({ ok: true, complete: result.complete, total: expectedChunkCount(session) });
}));

router.post("/", manage, asyncHandler(async (req, res) => {
  const input = materialCreateSchema.parse(req.body);
  let upload = null;
  if (input.kind === "file") {
    upload = await getUploadSession(input.uploadId);
    assertSessionOwner(upload, req.user);
    assertSessionScope(upload, input.classIds, input.subjectId);
    assertSessionActive(upload);
    await assertManageableScope(req.user, input.classIds, input.subjectId);

    if (upload.backend === "firestore" && upload.status !== "uploaded") {
      throw problem(400, "Finish uploading the file before adding it.");
    }
    if (upload.backend === "storage") {
      let uploaded = false;
      try {
        uploaded = await fileExists(upload.storage_path);
      } catch {
        uploaded = false;
      }
      if (!uploaded) throw problem(400, "The file was not received. Upload it again.");
    }
  }

  const id = await createMaterial(req.user, input, upload);
  try {
    await logActivity(req.user, "material_uploaded", { event: "materials" });
  } catch {
    // Metadata is already saved; logging must not make the request look failed.
  }
  return res.status(201).json({ material: { id } });
}));

router.patch("/:id", manage, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = materialUpdateSchema.parse(req.body);
  await updateMaterial(req.user, id, input);
  await logActivity(req.user, "material_updated", { event: "materials" });
  return res.json({ ok: true });
}));

router.delete("/:id", manage, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await deleteMaterial(req.user, id);
  await logActivity(req.user, "material_removed", { event: "materials" });
  return res.json({ ok: true, deleted: true });
}));

router.get("/:id/file", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const row = await getDocById("materials", id);
  if (!row || row.deleted_at || row.kind !== "file") {
    return res.status(404).json({ error: "Material not found." });
  }
  const allowed = await allowedClassIds(req.user);
  if (!visibleToUser(row, req.user, allowed)) {
    return res.status(403).json({ error: "This material is not assigned to your class." });
  }

  const stored = await readBlob(row.storage_path);
  if (!stored) {
    return res.status(404).json({ error: "This file is no longer available." });
  }
  if (!sameIds(stored.blob.class_ids, classIdsOf(row))) {
    return res.status(403).json({ error: "This file belongs to a different class." });
  }

  const fileName = String(stored.blob.file_name || "material");
  const encodedName = encodeURIComponent(fileName).replace(/'/g, "%27");
  return res
    .type(stored.blob.content_type || "application/octet-stream")
    .set("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`)
    .set("X-Content-Type-Options", "nosniff")
    .set("Cache-Control", "private, no-store")
    .send(stored.buffer);
}));

router.post("/:id/view", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await trackMaterialView(req.user, id);
  return res.json({ ok: true });
}));

module.exports = router;
