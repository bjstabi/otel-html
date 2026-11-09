import type { DataType } from 'apache-arrow';
import { Bool, Dictionary, Field, Float64, Int32, Int64, List, Schema, Utf8 } from 'apache-arrow';
import { type ColumnDef, TABLE_COLUMNS, type Table } from './columns.js';

function arrowType(def: ColumnDef): DataType {
  switch (def.type) {
    case 'utf8':
    case 'json':
      return def.dictionary ? new Dictionary(new Utf8(), new Int32()) : new Utf8();
    case 'int32':
      return new Int32();
    case 'int64':
      return new Int64();
    case 'float64':
      return new Float64();
    case 'bool':
      return new Bool();
    case 'list_float64':
      return new List(new Field('item', new Float64(), true));
    case 'list_int64':
      return new List(new Field('item', new Int64(), true));
  }
}

export function arrowSchema(table: Table): Schema {
  return new Schema(TABLE_COLUMNS[table].map((c) => new Field(c.name, arrowType(c), c.nullable)));
}
