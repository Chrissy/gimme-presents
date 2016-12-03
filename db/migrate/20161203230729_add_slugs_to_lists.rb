class AddSlugsToLists < ActiveRecord::Migration
  def change
    change_table :lists do |t|
      t.string :slug
    end

    add_index :lists, :slug, :unique => true
  end
end
