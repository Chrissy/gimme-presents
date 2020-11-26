# encoding: UTF-8
# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# Note that this schema.rb definition is the authoritative source for your
# database schema. If you need to create the application database on another
# system, you should be using db:schema:load, not running all the migrations
# from scratch. The latter is a flawed and unsustainable approach (the more migrations
# you'll amass, the slower it'll run and the greater likelihood for issues).
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema.define(version: 20201126022703) do

  # These are extensions that must be enabled in order to support this database
  enable_extension "plpgsql"

  create_table "gifts", force: :cascade do |t|
    t.integer  "list_id"
    t.string   "name"
    t.text     "url"
    t.text     "image"
    t.decimal  "price",      precision: 10, scale: 2
    t.datetime "created_at"
    t.datetime "updated_at"
    t.integer  "order"
    t.integer  "position"
  end

  create_table "lists", force: :cascade do |t|
    t.string   "name"
    t.string   "url"
    t.datetime "created_at"
    t.datetime "updated_at"
    t.integer  "user"
    t.integer  "order"
    t.string   "slug"
  end

  add_index "lists", ["slug"], name: "index_lists_on_slug", unique: true, using: :btree

  create_table "users", force: :cascade do |t|
    t.string "lists"
    t.string "provider"
    t.string "uid"
    t.string "name"
    t.string "image"
    t.string "email"
    t.string "password"
  end

end
