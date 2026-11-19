import type { KeyMapping } from "@apex/hid-catalog";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Storage for one user's remappings.
 *
 * **Why the shape differs from the .NET side.** SQLite got a relational model
 * with composite foreign keys, because the schema could then refuse a remap
 * whose target is not a real key. DynamoDB has no such constraint to offer —
 * there are no foreign keys — so modelling four tables would buy nothing and
 * cost four round trips. Instead the whole layout for one user and one
 * keyboard is a single item: one read to load it, one write to replace it,
 * and the write is atomic without a transaction.
 *
 * At 92 keys the item is a few kilobytes against a 400 KB limit, so the
 * single-item design has plenty of headroom. A keyboard with thousands of
 * keys would need the mappings split across items.
 *
 * **Isolation is physical.** The partition key is derived from the token's
 * `sub` and nothing else. A query can only ever name one partition, so one
 * user's read cannot reach another's items — not because the code declines
 * to, but because there is no key that addresses them.
 */

export interface StoredLayout {
  readonly mappings: readonly KeyMapping[];
  readonly updatedAt: string | null;
}

interface LayoutItem {
  pk: string;
  sk: string;
  /** from → to, as a map so a single item holds the whole layout. */
  mappings: Record<string, number>;
  updatedAt: string;
}

const EMPTY: StoredLayout = { mappings: [], updatedAt: null };

export class LayoutRepository {
  private readonly documents: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.documents = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  /** The caller's partition. Derived only from the verified `sub` claim. */
  private static partition(ownerSub: string): string {
    return `USER#${ownerSub}`;
  }

  private static sort(keyboardSlug: string): string {
    return `KEYBOARD#${keyboardSlug}`;
  }

  /**
   * A user who has never written gets an empty layout rather than an error.
   * That is the honest answer and saves the client a special case, matching
   * what the .NET implementation does with a missing `UserKeyboards` row.
   */
  async get(ownerSub: string, keyboardSlug: string): Promise<StoredLayout> {
    const result = await this.documents.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: LayoutRepository.partition(ownerSub),
          sk: LayoutRepository.sort(keyboardSlug),
        },
        // Reads are strongly consistent: a client that writes then
        // immediately reads must see its own change, or the UI appears to
        // lose edits. Eventually consistent reads cost half as much and would
        // make that race visible.
        ConsistentRead: true,
      }),
    );

    const item = result.Item as LayoutItem | undefined;
    if (!item) return EMPTY;

    return {
      mappings: Object.entries(item.mappings ?? {})
        .map(([from, to]) => ({ from: Number(from), to }))
        .sort((a, b) => a.from - b.from),
      updatedAt: item.updatedAt ?? null,
    };
  }

  /**
   * Replaces the whole layout. The API always computes the complete set
   * before calling this — POST merges first — so a single `PutItem` is both
   * correct and atomic, with no read-modify-write race.
   */
  async save(
    ownerSub: string,
    keyboardSlug: string,
    mappings: readonly KeyMapping[],
    now: Date,
  ): Promise<void> {
    // Nothing remapped means no item. Keeping an empty one would make
    // "never touched" and "cleared everything" different states that behave
    // identically, which is a distinction without a difference.
    if (mappings.length === 0) {
      await this.clear(ownerSub, keyboardSlug);
      return;
    }

    const item: LayoutItem = {
      pk: LayoutRepository.partition(ownerSub),
      sk: LayoutRepository.sort(keyboardSlug),
      mappings: Object.fromEntries(mappings.map(({ from, to }) => [String(from), to])),
      updatedAt: now.toISOString(),
    };

    await this.documents.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  /** Idempotent: deleting what is not there is a success, as the contract says. */
  async clear(ownerSub: string, keyboardSlug: string): Promise<void> {
    await this.documents.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          pk: LayoutRepository.partition(ownerSub),
          sk: LayoutRepository.sort(keyboardSlug),
        },
      }),
    );
  }

  /** Whether this user has ever saved a layout for this keyboard. */
  async owns(ownerSub: string, keyboardSlug: string): Promise<boolean> {
    const layout = await this.get(ownerSub, keyboardSlug);
    return layout.updatedAt !== null;
  }
}
