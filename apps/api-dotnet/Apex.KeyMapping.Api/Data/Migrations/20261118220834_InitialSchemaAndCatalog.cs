using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Apex.KeyMapping.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialSchemaAndCatalog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "KeyboardModels",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    Slug = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Vendor = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_KeyboardModels", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Keys",
                columns: table => new
                {
                    KeyboardModelId = table.Column<int>(type: "INTEGER", nullable: false),
                    HidCode = table.Column<int>(type: "INTEGER", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Category = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Keys", x => new { x.KeyboardModelId, x.HidCode });
                    table.CheckConstraint("CK_Keys_HidCode_8Bit", "[HidCode] BETWEEN 0 AND 255");
                    table.ForeignKey(
                        name: "FK_Keys_KeyboardModels_KeyboardModelId",
                        column: x => x.KeyboardModelId,
                        principalTable: "KeyboardModels",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "UserKeyboards",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    OwnerSub = table.Column<string>(type: "TEXT", nullable: false),
                    KeyboardModelId = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserKeyboards", x => x.Id);
                    table.UniqueConstraint("AK_UserKeyboards_Id_KeyboardModelId", x => new { x.Id, x.KeyboardModelId });
                    table.ForeignKey(
                        name: "FK_UserKeyboards_KeyboardModels_KeyboardModelId",
                        column: x => x.KeyboardModelId,
                        principalTable: "KeyboardModels",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "KeyMappings",
                columns: table => new
                {
                    UserKeyboardId = table.Column<int>(type: "INTEGER", nullable: false),
                    FromHidCode = table.Column<int>(type: "INTEGER", nullable: false),
                    KeyboardModelId = table.Column<int>(type: "INTEGER", nullable: false),
                    ToHidCode = table.Column<int>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_KeyMappings", x => new { x.UserKeyboardId, x.FromHidCode });
                    table.ForeignKey(
                        name: "FK_KeyMappings_Keys_KeyboardModelId_FromHidCode",
                        columns: x => new { x.KeyboardModelId, x.FromHidCode },
                        principalTable: "Keys",
                        principalColumns: new[] { "KeyboardModelId", "HidCode" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_KeyMappings_Keys_KeyboardModelId_ToHidCode",
                        columns: x => new { x.KeyboardModelId, x.ToHidCode },
                        principalTable: "Keys",
                        principalColumns: new[] { "KeyboardModelId", "HidCode" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_KeyMappings_UserKeyboards_UserKeyboardId_KeyboardModelId",
                        columns: x => new { x.UserKeyboardId, x.KeyboardModelId },
                        principalTable: "UserKeyboards",
                        principalColumns: new[] { "Id", "KeyboardModelId" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "KeyboardModels",
                columns: new[] { "Id", "Name", "Slug", "Vendor" },
                values: new object[] { 1, "Apex Pro Gen 3", "apex-pro-gen-3", "SteelSeries" });

            migrationBuilder.InsertData(
                table: "Keys",
                columns: new[] { "HidCode", "KeyboardModelId", "Category", "Name" },
                values: new object[,]
                {
                    { 4, 1, "Letters", "A" },
                    { 5, 1, "Letters", "B" },
                    { 6, 1, "Letters", "C" },
                    { 7, 1, "Letters", "D" },
                    { 8, 1, "Letters", "E" },
                    { 9, 1, "Letters", "F" },
                    { 10, 1, "Letters", "G" },
                    { 11, 1, "Letters", "H" },
                    { 12, 1, "Letters", "I" },
                    { 13, 1, "Letters", "J" },
                    { 14, 1, "Letters", "K" },
                    { 15, 1, "Letters", "L" },
                    { 16, 1, "Letters", "M" },
                    { 17, 1, "Letters", "N" },
                    { 18, 1, "Letters", "O" },
                    { 19, 1, "Letters", "P" },
                    { 20, 1, "Letters", "Q" },
                    { 21, 1, "Letters", "R" },
                    { 22, 1, "Letters", "S" },
                    { 23, 1, "Letters", "T" },
                    { 24, 1, "Letters", "U" },
                    { 25, 1, "Letters", "V" },
                    { 26, 1, "Letters", "W" },
                    { 27, 1, "Letters", "X" },
                    { 28, 1, "Letters", "Y" },
                    { 29, 1, "Letters", "Z" },
                    { 30, 1, "Numbers", "1" },
                    { 31, 1, "Numbers", "2" },
                    { 32, 1, "Numbers", "3" },
                    { 33, 1, "Numbers", "4" },
                    { 34, 1, "Numbers", "5" },
                    { 35, 1, "Numbers", "6" },
                    { 36, 1, "Numbers", "7" },
                    { 37, 1, "Numbers", "8" },
                    { 38, 1, "Numbers", "9" },
                    { 39, 1, "Numbers", "0" },
                    { 40, 1, "Special", "Enter" },
                    { 41, 1, "Special", "Escape" },
                    { 42, 1, "Special", "Backspace" },
                    { 43, 1, "Special", "Tab" },
                    { 44, 1, "Special", "Space" },
                    { 57, 1, "Special", "Caps Lock" },
                    { 58, 1, "Function", "F1" },
                    { 59, 1, "Function", "F2" },
                    { 60, 1, "Function", "F3" },
                    { 61, 1, "Function", "F4" },
                    { 62, 1, "Function", "F5" },
                    { 63, 1, "Function", "F6" },
                    { 64, 1, "Function", "F7" },
                    { 65, 1, "Function", "F8" },
                    { 66, 1, "Function", "F9" },
                    { 67, 1, "Function", "F10" },
                    { 68, 1, "Function", "F11" },
                    { 69, 1, "Function", "F12" },
                    { 70, 1, "Special", "Print Screen" },
                    { 71, 1, "Special", "Scroll Lock" },
                    { 72, 1, "Special", "Pause" },
                    { 73, 1, "Special", "Insert" },
                    { 74, 1, "Special", "Home" },
                    { 75, 1, "Special", "Page Up" },
                    { 76, 1, "Special", "Delete" },
                    { 77, 1, "Special", "End" },
                    { 78, 1, "Special", "Page Down" },
                    { 79, 1, "Arrows", "Right Arrow" },
                    { 80, 1, "Arrows", "Left Arrow" },
                    { 81, 1, "Arrows", "Down Arrow" },
                    { 82, 1, "Arrows", "Up Arrow" },
                    { 83, 1, "Numpad", "Num Lock" },
                    { 84, 1, "Numpad", "Numpad /" },
                    { 85, 1, "Numpad", "Numpad *" },
                    { 86, 1, "Numpad", "Numpad -" },
                    { 87, 1, "Numpad", "Numpad +" },
                    { 88, 1, "Numpad", "Numpad Enter" },
                    { 89, 1, "Numpad", "Numpad 1" },
                    { 90, 1, "Numpad", "Numpad 2" },
                    { 91, 1, "Numpad", "Numpad 3" },
                    { 92, 1, "Numpad", "Numpad 4" },
                    { 93, 1, "Numpad", "Numpad 5" },
                    { 94, 1, "Numpad", "Numpad 6" },
                    { 95, 1, "Numpad", "Numpad 7" },
                    { 96, 1, "Numpad", "Numpad 8" },
                    { 97, 1, "Numpad", "Numpad 9" },
                    { 98, 1, "Numpad", "Numpad 0" },
                    { 99, 1, "Numpad", "Numpad ." },
                    { 224, 1, "Modifiers", "Left Ctrl" },
                    { 225, 1, "Modifiers", "Left Shift" },
                    { 226, 1, "Modifiers", "Left Alt" },
                    { 227, 1, "Modifiers", "Left GUI (Win/Cmd)" },
                    { 228, 1, "Modifiers", "Right Ctrl" },
                    { 229, 1, "Modifiers", "Right Shift" },
                    { 230, 1, "Modifiers", "Right Alt" },
                    { 231, 1, "Modifiers", "Right GUI" }
                });

            migrationBuilder.CreateIndex(
                name: "IX_KeyboardModels_Slug",
                table: "KeyboardModels",
                column: "Slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_KeyMappings_KeyboardModelId_FromHidCode",
                table: "KeyMappings",
                columns: new[] { "KeyboardModelId", "FromHidCode" });

            migrationBuilder.CreateIndex(
                name: "IX_KeyMappings_KeyboardModelId_ToHidCode",
                table: "KeyMappings",
                columns: new[] { "KeyboardModelId", "ToHidCode" });

            migrationBuilder.CreateIndex(
                name: "IX_KeyMappings_UserKeyboardId_KeyboardModelId",
                table: "KeyMappings",
                columns: new[] { "UserKeyboardId", "KeyboardModelId" });

            migrationBuilder.CreateIndex(
                name: "IX_UserKeyboards_KeyboardModelId",
                table: "UserKeyboards",
                column: "KeyboardModelId");

            migrationBuilder.CreateIndex(
                name: "IX_UserKeyboards_OwnerSub_KeyboardModelId",
                table: "UserKeyboards",
                columns: new[] { "OwnerSub", "KeyboardModelId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "KeyMappings");

            migrationBuilder.DropTable(
                name: "Keys");

            migrationBuilder.DropTable(
                name: "UserKeyboards");

            migrationBuilder.DropTable(
                name: "KeyboardModels");
        }
    }
}
