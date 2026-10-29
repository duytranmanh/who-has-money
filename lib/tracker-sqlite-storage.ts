import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { TrackerCompany, TrackerContact, TrackerMessage, TrackerSequence } from "./tracker";

type CompanyFields = Omit<TrackerCompany, "contacts">;
type ContactFields = Omit<TrackerContact, "sequences">;
type SequenceFields = Omit<TrackerSequence, "messages">;

// Callers own the connection. Logic groups resource writes through transaction().
export function createSqliteTrackerStorage(db: DatabaseSync) {
  ////////////////////////////////////////////////////////////////////////////////
  // TRANSACTION MECHANICS                                                      //
  // Storage supplies BEGIN / COMMIT / ROLLBACK on this connection.             //
  // The logic layer chooses which business operations belong in transaction(). //
  // This block does not decide outreach rules or coordinate resource changes.  //
  ////////////////////////////////////////////////////////////////////////////////
  // Callbacks must finish synchronously: no transaction may span an await.
  function run<T>(mode: "BEGIN" | "BEGIN IMMEDIATE", operation: () => T): T {
    if (db.isTransaction) throw new Error("Nested tracker transactions are not supported.");
    db.exec(mode);
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Tracker transactions require synchronous callbacks.");
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      // Keep the original failure if SQLite has already rolled back the transaction.
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch {} }
      throw error;
    }
  }

  function transaction<T>(operation: () => T): T {
    return run("BEGIN IMMEDIATE", operation);
  }

  ///////////////////////////////////////////////////////////////////////////////////
  // PRIVATE SQL EXECUTION HELPERS                                                 //
  // Each resource read uses one SQL statement and a consistent snapshot.          //
  // Writes join the caller's transaction, or commit as individual SQL statements. //
  // These helpers do not define business transaction boundaries.                  //
  ///////////////////////////////////////////////////////////////////////////////////
  function write(sql: string, ...values: SQLInputValue[]): boolean {
    return db.prepare(sql).run(...values).changes > 0;
  }

  ////////////////////////////////////////////////////////////////////////////////
  // RESOURCE READS                                                             //
  // Map stored rows into ordered tracker objects, including owned children.    //
  // Business validation and derived outreach status belong to the logic layer. //
  ////////////////////////////////////////////////////////////////////////////////
  function listMessages(sequenceId: string): TrackerMessage[] {
    return db.prepare(`SELECT id, kind, text, sent_at AS sentAt, notes FROM messages
      WHERE sequence_id = ? ORDER BY position`).all(sequenceId) as TrackerMessage[];
  }

  function getMessage(id: string): TrackerMessage | undefined {
    return db.prepare("SELECT id, kind, text, sent_at AS sentAt, notes FROM messages WHERE id = ?").get(id) as TrackerMessage | undefined;
  }

  // Filters are internal SQL fragments; caller-provided IDs are always bound parameters.
  // LEFT JOINs preserve parents without children. Maps collapse repeated parent rows.
  function readCompanies(where = "1 = 1", values: SQLInputValue[] = []): TrackerCompany[] {
    const rows = db.prepare(`SELECT c.id AS companyId, c.name AS companyName, c.notes AS companyNotes,
      p.id AS contactId, p.name AS contactName, p.email, p.links_json,
      s.id AS sequenceId, s.closed_at, s.close_reason, s.responded_at,
      m.id AS messageId, m.kind, m.text, m.sent_at, m.notes AS messageNotes
      FROM companies c
      LEFT JOIN contacts p ON p.company_id = c.id
      LEFT JOIN sequences s ON s.contact_id = p.id
      LEFT JOIN messages m ON m.sequence_id = s.id
      WHERE ${where} ORDER BY c.position, p.position, s.position, m.position`).all(...values);
    const companies = new Map<string, TrackerCompany>();
    const contacts = new Map<string, TrackerContact>();
    const sequences = new Map<string, TrackerSequence>();
    for (const row of rows) {
      const companyId = row.companyId as string;
      let company = companies.get(companyId);
      if (!company) {
        company = { id: companyId, name: row.companyName as string, notes: row.companyNotes as string, contacts: [] };
        companies.set(companyId, company);
      }
      if (row.contactId === null) continue;
      const contactId = row.contactId as string;
      let contact = contacts.get(contactId);
      if (!contact) {
        contact = { id: contactId, name: row.contactName as string, email: row.email as string,
          links: JSON.parse(row.links_json as string) as string[], sequences: [] };
        contacts.set(contactId, contact);
        company.contacts.push(contact);
      }
      if (row.sequenceId === null) continue;
      const sequenceId = row.sequenceId as string;
      let sequence = sequences.get(sequenceId);
      if (!sequence) {
        sequence = { id: sequenceId, closedAt: row.closed_at as string | null,
          closeReason: row.close_reason as TrackerSequence["closeReason"],
          respondedAt: row.responded_at as string | null, messages: [] };
        sequences.set(sequenceId, sequence);
        contact.sequences.push(sequence);
      }
      if (row.messageId === null) continue;
      sequence.messages.push({ id: row.messageId as string, kind: row.kind as TrackerMessage["kind"],
        text: row.text as string, sentAt: row.sent_at as string, notes: row.messageNotes as string });
    }
    return [...companies.values()];
  }

  function listSequences(contactId: string): TrackerSequence[] {
    return readCompanies("p.id = ?", [contactId])[0]?.contacts[0]?.sequences ?? [];
  }

  function getSequence(id: string): TrackerSequence | undefined {
    return readCompanies("s.id = ?", [id])[0]?.contacts[0]?.sequences[0];
  }

  function listContacts(companyId: string): TrackerContact[] {
    return readCompanies("c.id = ?", [companyId])[0]?.contacts ?? [];
  }

  function getContact(id: string): TrackerContact | undefined {
    return readCompanies("p.id = ?", [id])[0]?.contacts[0];
  }

  function listCompanies(): TrackerCompany[] {
    return readCompanies();
  }

  function getCompany(id: string): TrackerCompany | undefined {
    return readCompanies("c.id = ?", [id])[0];
  }

  ///////////////////////////////////////////////////////////////////////////////
  // RESOURCE INSERTS AND UPDATES                                              //
  // Persist one resource's fields without saving its child collections.       //
  // Logic validates the operation and groups related writes in transaction(). //
  // For example, restarting outreach closes a sequence and inserts a new      //
  // sequence and initial message within one caller-owned transaction.         //
  ///////////////////////////////////////////////////////////////////////////////
  // Inserts append in creation order. Child collections are persisted with their own resource methods.
  function insertCompany(company: CompanyFields): void {
    write(`INSERT INTO companies (id, name, notes, position)
      SELECT ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM companies`, company.id, company.name, company.notes);
  }

  function updateCompany(company: CompanyFields): boolean {
    return write("UPDATE companies SET name = ?, notes = ? WHERE id = ?", company.name, company.notes, company.id);
  }

  function insertContact(companyId: string, contact: ContactFields): void {
    write(`INSERT INTO contacts (id, company_id, name, email, links_json, position)
      SELECT ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM contacts WHERE company_id = ?`,
    contact.id, companyId, contact.name, contact.email, JSON.stringify(contact.links), companyId);
  }

  function updateContact(contact: ContactFields): boolean {
    return write("UPDATE contacts SET name = ?, email = ?, links_json = ? WHERE id = ?",
      contact.name, contact.email, JSON.stringify(contact.links), contact.id);
  }

  function insertSequence(contactId: string, sequence: SequenceFields): void {
    write(`INSERT INTO sequences (id, contact_id, closed_at, close_reason, responded_at, position)
      SELECT ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM sequences WHERE contact_id = ?`,
    sequence.id, contactId, sequence.closedAt, sequence.closeReason, sequence.respondedAt, contactId);
  }

  function updateSequence(sequence: SequenceFields): boolean {
    return write("UPDATE sequences SET closed_at = ?, close_reason = ?, responded_at = ? WHERE id = ?",
      sequence.closedAt, sequence.closeReason, sequence.respondedAt, sequence.id);
  }

  function insertMessage(sequenceId: string, message: TrackerMessage): void {
    write(`INSERT INTO messages (id, sequence_id, kind, text, sent_at, notes, position)
      SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM messages WHERE sequence_id = ?`,
    message.id, sequenceId, message.kind, message.text, message.sentAt, message.notes, sequenceId);
  }

  function updateMessage(message: TrackerMessage): boolean {
    return write("UPDATE messages SET text = ?, sent_at = ?, notes = ? WHERE id = ?",
      message.text, message.sentAt, message.notes, message.id);
  }

  /////////////////////////////////////////////////////////////////////////////////
  // RESOURCE DELETES                                                            //
  // Remove the selected resource and its owned descendants.                     //
  // Logic decides whether deletion is allowed and wraps parent deletes in       //
  // transaction(): their multiple SQL statements must succeed or fail together. //
  /////////////////////////////////////////////////////////////////////////////////
  // Parent deletion removes owned history explicitly because the schema uses restrictive foreign keys.
  // Callers must group these multi-statement deletes in transaction() for atomicity.
  function deleteSequence(id: string): boolean {
    write("DELETE FROM messages WHERE sequence_id = ?", id);
    return write("DELETE FROM sequences WHERE id = ?", id);
  }

  function deleteContact(id: string): boolean {
    write("DELETE FROM messages WHERE sequence_id IN (SELECT id FROM sequences WHERE contact_id = ?)", id);
    write("DELETE FROM sequences WHERE contact_id = ?", id);
    return write("DELETE FROM contacts WHERE id = ?", id);
  }

  function deleteCompany(id: string): boolean {
    write(`DELETE FROM messages WHERE sequence_id IN (SELECT id FROM sequences
      WHERE contact_id IN (SELECT id FROM contacts WHERE company_id = ?))`, id);
    write("DELETE FROM sequences WHERE contact_id IN (SELECT id FROM contacts WHERE company_id = ?)", id);
    write("DELETE FROM contacts WHERE company_id = ?", id);
    return write("DELETE FROM companies WHERE id = ?", id);
  }

  function deleteMessage(id: string): boolean {
    return write("DELETE FROM messages WHERE id = ?", id);
  }

  return { transaction, listCompanies, getCompany, insertCompany, updateCompany, deleteCompany,
    listContacts, getContact, insertContact, updateContact, deleteContact,
    listSequences, getSequence, insertSequence, updateSequence, deleteSequence,
    listMessages, getMessage, insertMessage, updateMessage, deleteMessage };
}
