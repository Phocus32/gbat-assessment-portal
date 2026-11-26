"use strict";

/**
 * Learning-material data access. Materials are soft-deleted like quizzes and
 * are always read through a class scope: students see their own class only,
 * teachers see their explicitly assigned classes, and admins see everything.
 */

const { FieldValue } = require("firebase-admin/firestore");
const {
  getDocById,
  getManyByIds,
  insertDoc,
  listAll,
  listClasses,
  updateDocById
} = require("./fdb");
const { listSubjects, subjectIdsOf } = require("./subjects");
const { allowedClassIds: allowedClassIdsFor, classIdsOf } = require("./class-access");
const { TYPE_LABELS, hasUsableBucket, createReadUrl } = require("./storage");
const { blobExists } = require("./material-blobs");
const { consumeUploadSession } = require("./upload-sessions");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function allowedClassIds(user) {
  return allowedClassIdsFor(user);
}

async function manageableClasses(user) {
  const [classes, allowed] = await Promise.all([listClasses(), allowedClassIds(user)]);
  return classes
    .filter(cls => allowed.has(Number(cls.id)))
    .map(cls => ({ id: Number(cls.id), name: cls.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function assertManageableScope(user, classIds, subjectId) {
  const allowed = await allowedClassIds(user);
  const requested = [...new Set(classIds.map(Number))];
  if (!requested.length) throw httpError(400, "Select at least one class.");
  for (const classId of requested) {
    if (!allowed.has(classId)) {
      throw httpError(403, "One or more selected classes are outside your scope.");
    }
  }

  const existing = await getManyByIds("classes", requested);
  if (existing.length !== requested.length) throw httpError(404, "Class not found.");

  if (subjectId === null || subjectId === undefined) return;
  const subject = await getDocById("subjects", subjectId);
  if (!subject) throw httpError(404, "Subject not found.");
  if (user.role === "teacher" && !subjectIdsOf(user).includes(Number(subjectId))) {
    throw httpError(403, "That subject is outside your scope.");
  }
}

function visibleToUser(row, user, allowed) {
  if (!row || row.deleted_at) return false;
  if (user.role === "admin") return true;
  return classIdsOf(row).some(classId => allowed.has(classId));
}

async function serialiseMaterial(row, classMap, subjectMap, userMap, storageReady) {
  let url = null;
  if (row.kind === "link") {
    url = row.link_url || null;
  } else {
    const usesStorage = row.backend ? row.backend === "storage" : storageReady;
    if (usesStorage && storageReady) {
      try {
        url = await createReadUrl(row.storage_path);
      } catch {
        url = null;
      }
    }
    if (!url && row.storage_path && await blobExists(row.storage_path)) {
      url = `/api/materials/${row.id}/file`;
    }
  }

  const classIds = classIdsOf(row);
  const uploader = row.uploaded_by ? userMap.get(Number(row.uploaded_by)) : null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || "",
    kind: row.kind,
    fileType: row.file_type,
    typeLabel: TYPE_LABELS[row.file_type] || "Material",
    subjectId: row.subject_id === null || row.subject_id === undefined
      ? null
      : Number(row.subject_id),
    subjectName: row.subject_id ? (subjectMap.get(Number(row.subject_id)) || null) : null,
    classIds,
    classNames: classIds.map(id => classMap.get(id)).filter(Boolean),
    fileName: row.file_name || null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined
      ? null
      : Number(row.size_bytes),
    url,
    views: Number(row.views || 0),
    uploadedBy: row.uploaded_by ? Number(row.uploaded_by) : null,
    uploadedByName: uploader ? uploader.name : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listMaterials(user, filters = {}) {
  const [rows, classes, subjects, users, allowed] = await Promise.all([
    listAll("materials"),
    listClasses(),
    listSubjects(),
    listAll("users"),
    allowedClassIds(user)
  ]);

  let visible = rows.filter(row => visibleToUser(row, user, allowed));
  if (filters.subjectId) {
    visible = visible.filter(row => Number(row.subject_id) === Number(filters.subjectId));
  }
  if (filters.classId) {
    visible = visible.filter(row =>
      allowed.has(Number(filters.classId)) && classIdsOf(row).includes(Number(filters.classId))
    );
  }
  if (filters.type) {
    visible = visible.filter(row => row.file_type === filters.type);
  }
  if (filters.q) {
    const needle = String(filters.q).toLowerCase();
    visible = visible.filter(row =>
      String(row.title || "").toLowerCase().includes(needle)
      || String(row.description || "").toLowerCase().includes(needle)
    );
  }

  visible.sort((a, b) => {
    const left = a.created_at instanceof Date ? a.created_at.getTime() : 0;
    const right = b.created_at instanceof Date ? b.created_at.getTime() : 0;
    return right - left;
  });

  const classMap = new Map(classes.map(cls => [Number(cls.id), cls.name]));
  const subjectMap = new Map(subjects.map(subject => [Number(subject.id), subject.name]));
  const userMap = new Map(users.map(item => [Number(item.id), item]));
  const storageReady = visible.some(row => row.kind === "file")
    ? await hasUsableBucket()
    : false;
  const materials = [];
  for (const row of visible) {
    materials.push(await serialiseMaterial(row, classMap, subjectMap, userMap, storageReady));
  }

  return {
    materials,
    classes: user.role === "student"
      ? classes.filter(cls => allowed.has(Number(cls.id))).map(cls => ({ id: Number(cls.id), name: cls.name }))
      : await manageableClasses(user),
    subjects: subjects.map(subject => ({ id: Number(subject.id), name: subject.name })),
    canManage: user.role !== "student"
  };
}

async function createMaterial(user, input, upload = null) {
  await assertManageableScope(user, input.classIds, input.subjectId);
  const consumed = upload
    ? await consumeUploadSession(upload.id, user, input.classIds, input.subjectId)
    : null;
  const id = await insertDoc("materials", {
    title: input.title,
    description: input.description || "",
    kind: input.kind,
    file_type: consumed ? consumed.file_type : input.fileType,
    subject_id: input.subjectId === undefined ? null : input.subjectId,
    class_ids: input.classIds.map(Number),
    backend: consumed ? consumed.backend : null,
    storage_path: consumed ? consumed.storage_path : null,
    file_name: consumed ? consumed.file_name : null,
    size_bytes: consumed ? consumed.size_bytes : null,
    upload_id: consumed ? consumed.id : null,
    link_url: input.kind === "link" ? input.linkUrl : null,
    uploaded_by: user.id,
    views: 0,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null
  }, "materials");
  return id;
}

async function updateMaterial(user, id, patch) {
  const row = await getDocById("materials", id);
  if (!row || row.deleted_at) throw httpError(404, "Material not found.");
  if (user.role === "teacher" && Number(row.uploaded_by) !== Number(user.id)) {
    throw httpError(403, "You can only edit materials you uploaded.");
  }
  await assertManageableScope(
    user,
    classIdsOf(row),
    patch.subjectId === undefined ? row.subject_id : patch.subjectId
  );

  const changes = { updated_at: new Date() };
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.description !== undefined) changes.description = patch.description;
  if (patch.fileType !== undefined) changes.file_type = patch.fileType;
  if (patch.subjectId !== undefined) changes.subject_id = patch.subjectId;
  await updateDocById("materials", Number(id), changes);
}

async function deleteMaterial(user, id) {
  const row = await getDocById("materials", id);
  if (!row || row.deleted_at) throw httpError(404, "Material not found.");
  if (user.role === "teacher") {
    if (Number(row.uploaded_by) !== Number(user.id)) {
      throw httpError(403, "You can only remove materials you uploaded.");
    }
    const allowed = await allowedClassIds(user);
    if (!classIdsOf(row).some(classId => allowed.has(classId))) {
      throw httpError(403, "That material is outside your scope.");
    }
  }
  await updateDocById("materials", Number(id), {
    deleted_at: new Date(),
    deleted_by: user.id,
    updated_at: new Date()
  });
}

async function trackMaterialView(user, id) {
  const row = await getDocById("materials", id);
  if (!row || row.deleted_at) throw httpError(404, "Material not found.");
  const allowed = await allowedClassIds(user);
  if (!visibleToUser(row, user, allowed)) {
    throw httpError(403, "This material is not assigned to your class.");
  }
  await updateDocById("materials", Number(id), { views: FieldValue.increment(1) });
}

module.exports = {
  classIdsOf,
  allowedClassIds,
  manageableClasses,
  assertManageableScope,
  visibleToUser,
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  trackMaterialView
};
