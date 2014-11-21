class CreateLists < ActiveRecord::Migration
  def change
    create_table :lists do |t|
      t.string :name
      t.string :url
      t.timestamps
    end
    
    create_table :gifts do |t|
      t.belongs_to :list
      t.string :name
      t.string :url
      t.string :image
      t.decimal :price, :precision => 10, :scale => 2
      t.timestamps
    end
  end
end
